# Private notebook photos are normalized. The API writes private files
# and streams authorized reads; there is no public/CloudFront or presigned access.
resource "aws_s3_bucket" "mydesk_attachments" {
  bucket        = "${local.name}-mydesk-attachments"
  force_destroy = false
  tags          = { Name = "${local.name}-mydesk-attachments" }
}

resource "aws_s3_bucket_public_access_block" "mydesk_attachments" {
  bucket                  = aws_s3_bucket.mydesk_attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "mydesk_attachments" {
  bucket = aws_s3_bucket.mydesk_attachments.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "mydesk_attachments" {
  bucket = aws_s3_bucket.mydesk_attachments.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "mydesk_attachments" {
  bucket = aws_s3_bucket.mydesk_attachments.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {
      prefix = "mydesk/"
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_policy" "mydesk_attachments" {
  bucket = aws_s3_bucket.mydesk_attachments.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "RequireTLS"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.mydesk_attachments.arn, "${aws_s3_bucket.mydesk_attachments.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.mydesk_attachments]
}
