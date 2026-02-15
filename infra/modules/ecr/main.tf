# ============================================================================
# ECR Module — Container Registry
# ============================================================================

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"
  force_delete         = var.environment != "production"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Name = "${local.name}-api" }
}

# Keep only last 10 untagged images
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 untagged images"
      selection = {
        tagStatus   = "untagged"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}
