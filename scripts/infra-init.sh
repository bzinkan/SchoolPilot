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
echo "  1. Provision the required /schoolpilot/staging/* runtime SecureStrings"
echo "     with the approved credential-rotation workflow. Never pass secret values"
echo "     through Terraform variables, plans, or state."
echo ""
echo "  2. Plan the staging environment:"
echo "     cd infra"
echo "     terraform plan -var-file=staging.tfvars -out=<external-saved-plan>"
echo ""
echo "  3. Apply only the reviewed saved plan:"
echo "     terraform apply <external-saved-plan>"
echo ""
echo "  4. Deploy (the backend deploy runs the private-RDS migration task):"
echo "     cd .. && ./scripts/deploy.sh staging"
