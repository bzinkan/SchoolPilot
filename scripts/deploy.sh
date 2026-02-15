#!/bin/bash
# ============================================================================
# SchoolPilot Deploy Script
# Usage: ./scripts/deploy.sh [staging|production]
# ============================================================================

set -euo pipefail

ENV="${1:-staging}"
REGION="us-east-1"
PROJECT="schoolpilot"
IMAGE_TAG="${2:-latest}"

if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "Usage: $0 [staging|production] [image-tag]"
  exit 1
fi

NAME="${PROJECT}-${ENV}"
echo "=== Deploying SchoolPilot ($ENV) ==="

# --- Get AWS account ID ---
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${NAME}-api"

echo ""
echo "Account:  $ACCOUNT_ID"
echo "ECR Repo: $ECR_REPO"
echo "Tag:      $IMAGE_TAG"
echo ""

# --- Step 1: Build and push Docker image ---
echo "=== Step 1: Building Docker image ==="
docker build -t "${NAME}-api:${IMAGE_TAG}" .

echo "=== Step 1b: Logging into ECR ==="
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "=== Step 1c: Pushing to ECR ==="
docker tag "${NAME}-api:${IMAGE_TAG}" "${ECR_REPO}:${IMAGE_TAG}"
docker push "${ECR_REPO}:${IMAGE_TAG}"

# Also tag as latest
if [[ "$IMAGE_TAG" != "latest" ]]; then
  docker tag "${NAME}-api:${IMAGE_TAG}" "${ECR_REPO}:latest"
  docker push "${ECR_REPO}:latest"
fi

# --- Step 2: Update ECS service (force new deployment) ---
echo ""
echo "=== Step 2: Updating ECS service ==="
CLUSTER="${NAME}-cluster"
SERVICE="${NAME}-api"

aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --force-new-deployment \
  --region "$REGION" \
  --no-cli-pager

echo ""
echo "=== Step 3: Waiting for deployment to stabilize ==="
aws ecs wait services-stable \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --region "$REGION"

echo ""
echo "=== API deployment complete! ==="

# --- Step 3: Build and deploy frontend ---
echo ""
echo "=== Step 4: Building frontend ==="
cd schoolpilot-app
npm ci
npm run build
cd ..

echo "=== Step 4b: Syncing to S3 ==="
BUCKET="${NAME}-frontend"
aws s3 sync schoolpilot-app/dist/ "s3://${BUCKET}/" \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html" \
  --exclude "*.json"

# Upload index.html and manifests with no-cache
aws s3 cp schoolpilot-app/dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "no-cache, no-store, must-revalidate"

# Upload any JSON manifests with short cache
for f in schoolpilot-app/dist/*.json; do
  [ -f "$f" ] && aws s3 cp "$f" "s3://${BUCKET}/$(basename $f)" \
    --cache-control "public, max-age=60"
done

echo "=== Step 4c: Invalidating CloudFront cache ==="
DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${NAME} frontend'].Id" \
  --output text)

if [[ -n "$DIST_ID" && "$DIST_ID" != "None" ]]; then
  aws cloudfront create-invalidation \
    --distribution-id "$DIST_ID" \
    --paths "/index.html" "/*.json" \
    --no-cli-pager
  echo "CloudFront invalidation created for distribution $DIST_ID"
else
  echo "WARNING: Could not find CloudFront distribution. Skip invalidation."
fi

echo ""
echo "=== Deployment complete! ==="
echo "API:      Check ECS service in AWS Console"
echo "Frontend: https://${BUCKET}.s3.amazonaws.com (or your CloudFront domain)"
