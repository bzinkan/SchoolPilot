#!/bin/bash
# ============================================================================
# SchoolPilot Infrastructure — First-time Setup
# Run this once to initialize Terraform and create the S3 state backend
# Usage: ./scripts/infra-init.sh
# ============================================================================

set -euo pipefail

REGION="us-east-1"
STATE_BUCKET="schoolpilot-terraform-state"
LOCK_TABLE="schoolpilot-terraform-locks"

echo "=== SchoolPilot Infrastructure Init ==="
echo ""

# --- Step 1: Create S3 bucket for Terraform state ---
echo "Step 1: Creating S3 state bucket..."
if aws s3api head-bucket --bucket "$STATE_BUCKET" 2>/dev/null; then
  echo "  Bucket '$STATE_BUCKET' already exists."
else
  aws s3api create-bucket \
    --bucket "$STATE_BUCKET" \
    --region "$REGION"

  aws s3api put-bucket-versioning \
    --bucket "$STATE_BUCKET" \
    --versioning-configuration Status=Enabled

  aws s3api put-bucket-encryption \
    --bucket "$STATE_BUCKET" \
    --server-side-encryption-configuration '{
      "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]
    }'

  aws s3api put-public-access-block \
    --bucket "$STATE_BUCKET" \
    --public-access-block-configuration '{
      "BlockPublicAcls": true,
      "IgnorePublicAcls": true,
      "BlockPublicPolicy": true,
      "RestrictPublicBuckets": true
    }'

  echo "  Created bucket '$STATE_BUCKET'"
fi

# --- Step 2: Create DynamoDB table for state locking ---
echo "Step 2: Creating DynamoDB lock table..."
if aws dynamodb describe-table --table-name "$LOCK_TABLE" --region "$REGION" &>/dev/null; then
  echo "  Table '$LOCK_TABLE' already exists."
else
  aws dynamodb create-table \
    --table-name "$LOCK_TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$REGION" \
    --no-cli-pager

  echo "  Created table '$LOCK_TABLE'"
fi

# --- Step 3: Init Terraform ---
echo ""
echo "Step 3: Initializing Terraform..."
cd infra
terraform init

echo ""
echo "=== Done! ==="
echo ""
echo "Next steps:"
echo "  1. Generate secrets:"
echo "     SESSION_SECRET=\$(openssl rand -hex 32)"
echo "     JWT_SECRET=\$(openssl rand -hex 32)"
echo "     STUDENT_TOKEN_SECRET=\$(openssl rand -hex 32)"
echo ""
echo "  2. Plan the staging environment:"
echo "     cd infra"
echo "     terraform plan -var-file=staging.tfvars \\"
echo "       -var='session_secret=<SECRET>' \\"
echo "       -var='jwt_secret=<SECRET>'"
echo ""
echo "  3. Apply:"
echo "     terraform apply -var-file=staging.tfvars \\"
echo "       -var='session_secret=<SECRET>' \\"
echo "       -var='jwt_secret=<SECRET>'"
echo ""
echo "  4. Push schema to RDS:"
echo "     DATABASE_URL=\$(terraform output -raw rds_endpoint) npm run db:push"
echo ""
echo "  5. Deploy:"
echo "     cd .. && ./scripts/deploy.sh staging"
