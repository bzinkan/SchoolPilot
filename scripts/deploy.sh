#!/bin/bash
# ============================================================================
# SchoolPilot Deploy Script
# Works on macOS, Linux, and Windows (Git Bash / WSL)
#
# Usage:
#   ./scripts/deploy.sh                  # Deploy everything (backend + frontend)
#   ./scripts/deploy.sh --backend        # Backend only (Docker → ECR → ECS)
#   ./scripts/deploy.sh --frontend       # Frontend only (Vite build → S3 → CloudFront)
#   ./scripts/deploy.sh --skip-wait      # Deploy without waiting for ECS stabilization
#   ./scripts/deploy.sh production       # Explicit environment (default: production)
# ============================================================================

set -euo pipefail

# --- Parse arguments ---
ENV="production"
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
SKIP_WAIT=false
IMAGE_TAG="latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)  DEPLOY_FRONTEND=false; shift ;;
    --frontend) DEPLOY_BACKEND=false; shift ;;
    --skip-wait) SKIP_WAIT=true; shift ;;
    --tag)      IMAGE_TAG="$2"; shift 2 ;;
    staging|production) ENV="$1"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# --- Configuration ---
REGION="us-east-1"
PROJECT="schoolpilot"
NAME="${PROJECT}-${ENV}"

# Hardcoded known values (faster than querying AWS each time)
ACCOUNT_ID="135775632425"
CF_DIST_ID="E1TPPJOD7C2CXR"

ECR_REPO="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${NAME}-api"
CLUSTER="${NAME}-cluster"
SERVICE="${NAME}-api"
BUCKET="${NAME}-frontend"

# Colors (works in most terminals)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()    { echo -e "${BLUE}==>${NC} $*"; }
success() { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}==>${NC} $*"; }
error()   { echo -e "${RED}==>${NC} $*"; }

# --- Preflight checks ---
echo ""
echo "=========================================="
echo "  SchoolPilot Deploy ($ENV)"
echo "=========================================="
echo ""
info "ECR:        $ECR_REPO"
info "ECS:        $CLUSTER / $SERVICE"
info "S3:         $BUCKET"
info "CloudFront: $CF_DIST_ID"
info "Backend:    $DEPLOY_BACKEND"
info "Frontend:   $DEPLOY_FRONTEND"
echo ""

# Verify AWS credentials
if ! aws sts get-caller-identity --region "$REGION" > /dev/null 2>&1; then
  error "AWS credentials not configured. Run 'aws configure' first."
  exit 1
fi
success "AWS credentials OK"

# Resolve project root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"
info "Working directory: $PROJECT_ROOT"

# ============================================================================
# BACKEND DEPLOY
# ============================================================================
if [[ "$DEPLOY_BACKEND" == true ]]; then
  echo ""
  echo "=========================================="
  echo "  Backend: Docker → ECR → ECS"
  echo "=========================================="

  # Step 1: Build Docker image
  info "Building Docker image..."
  docker build -t "${NAME}-api:${IMAGE_TAG}" .
  success "Docker build complete"

  # Step 2: Login to ECR
  info "Logging into ECR..."
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
  success "ECR login OK"

  # Step 3: Tag and push
  info "Pushing to ECR..."
  docker tag "${NAME}-api:${IMAGE_TAG}" "${ECR_REPO}:${IMAGE_TAG}"
  docker push "${ECR_REPO}:${IMAGE_TAG}"

  if [[ "$IMAGE_TAG" != "latest" ]]; then
    docker tag "${NAME}-api:${IMAGE_TAG}" "${ECR_REPO}:latest"
    docker push "${ECR_REPO}:latest"
  fi
  success "Image pushed: ${ECR_REPO}:${IMAGE_TAG}"

  # Step 4: Force new ECS deployment
  info "Triggering ECS deployment..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --force-new-deployment \
    --region "$REGION" \
    --query 'service.{status:status,desired:desiredCount,running:runningCount}' \
    --output table

  if [[ "$SKIP_WAIT" == true ]]; then
    warn "Skipping ECS stabilization wait (--skip-wait)"
  else
    info "Waiting for ECS deployment to stabilize (this may take 2-5 minutes)..."
    aws ecs wait services-stable \
      --cluster "$CLUSTER" \
      --services "$SERVICE" \
      --region "$REGION"
    success "ECS deployment stable"
  fi

  success "Backend deploy complete!"
fi

# ============================================================================
# FRONTEND DEPLOY
# ============================================================================
if [[ "$DEPLOY_FRONTEND" == true ]]; then
  echo ""
  echo "=========================================="
  echo "  Frontend: Vite Build → S3 → CloudFront"
  echo "=========================================="

  # Step 1: Build frontend
  info "Installing dependencies..."
  cd "$PROJECT_ROOT/schoolpilot-app"
  npm ci --silent

  info "Building frontend..."
  npm run build
  cd "$PROJECT_ROOT"
  success "Frontend build complete"

  # Step 2: Sync to S3
  info "Syncing to S3..."

  # Hashed assets get long cache (immutable)
  aws s3 sync schoolpilot-app/dist/ "s3://${BUCKET}/" \
    --delete \
    --cache-control "public, max-age=31536000, immutable" \
    --exclude "index.html" \
    --exclude "*.json" \
    --region "$REGION"

  # index.html — never cache (always serve fresh)
  aws s3 cp schoolpilot-app/dist/index.html "s3://${BUCKET}/index.html" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --region "$REGION"

  # JSON manifests — short cache
  for f in schoolpilot-app/dist/*.json; do
    if [[ -f "$f" ]]; then
      aws s3 cp "$f" "s3://${BUCKET}/$(basename "$f")" \
        --cache-control "public, max-age=60" \
        --region "$REGION"
    fi
  done
  success "S3 sync complete"

  # Step 3: Invalidate CloudFront
  info "Invalidating CloudFront cache..."
  aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/index.html" "/*.json" \
    --region "$REGION" \
    --query 'Invalidation.{Id:Id,Status:Status}' \
    --output table
  success "CloudFront invalidation created"

  success "Frontend deploy complete!"
fi

# ============================================================================
# Done
# ============================================================================
echo ""
echo "=========================================="
success "All done! Deployment summary:"
echo "=========================================="
[[ "$DEPLOY_BACKEND" == true ]]  && echo "  API:      ECS service updated (image: ${IMAGE_TAG})"
[[ "$DEPLOY_FRONTEND" == true ]] && echo "  Frontend: S3 synced, CloudFront invalidated"
echo ""
