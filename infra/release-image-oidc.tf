variable "enable_release_image_publisher" {
  description = "Provision the production GitHub Actions OIDC role for publishing signed ECR release images."
  type        = bool
  default     = false
}

locals {
  enable_release_image_publisher = var.environment == "production" && var.enable_release_image_publisher
  release_image_account          = data.aws_caller_identity.current.account_id
  release_image_service_prefix   = "arn:aws:ecs:${var.aws_region}:${local.release_image_account}:service/${module.ecs.cluster_name}/"
}

data "aws_iam_openid_connect_provider" "release_image_github" {
  count = local.enable_release_image_publisher ? 1 : 0

  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "release_image_publisher" {
  count = local.enable_release_image_publisher ? 1 : 0

  name = "${local.name}-release-image-publisher"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = data.aws_iam_openid_connect_provider.release_image_github[0].arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:bzinkan/SchoolPilot:environment:release-image"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "release_image_publisher" {
  count = local.enable_release_image_publisher ? 1 : 0

  name = "publish-release-image"
  role = aws_iam_role.release_image_publisher[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "GetRegistryAuthorization"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "PublishSchoolPilotImageAndAttestations"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:BatchGetImage",
          "ecr:CompleteLayerUpload",
          "ecr:DescribeImages",
          "ecr:GetDownloadUrlForLayer",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
        ]
        Resource = "arn:aws:ecr:${var.aws_region}:${local.release_image_account}:repository/${module.ecr.repository_name}"
      },
      {
        Sid    = "ReadServingServiceIdentity"
        Effect = "Allow"
        Action = "ecs:DescribeServices"
        Resource = [
          "${local.release_image_service_prefix}${module.ecs.service_name}",
          "${local.release_image_service_prefix}${module.ecs.worker_service_name}",
        ]
      },
      {
        Sid      = "ReadRollbackImage"
        Effect   = "Allow"
        Action   = "ecs:DescribeTaskDefinition"
        Resource = "*"
      },
    ]
  })
}

output "release_image_publisher_role_arn" {
  description = "Release-image environment's AWS_RELEASE_IMAGE_ROLE_ARN when the publisher is enabled."
  value       = one(aws_iam_role.release_image_publisher[*].arn)
}
