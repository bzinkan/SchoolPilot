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
#   ./scripts/deploy.sh --tag abc123     # Override default git-SHA image tag
# ============================================================================

set -euo pipefail

# --- Parse arguments ---
ENV="production"
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
SKIP_WAIT=false
IMAGE_TAG=""

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
WORKER_SERVICE="${NAME}-scheduler-worker"
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

ecs_service_status() {
  aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$1" \
    --query 'services[0].status' \
    --output text \
    --region "$REGION" 2>/dev/null || true
}

TEMP_FILES=(
  .taskdef-current.json
  .taskdef-template.json
  .taskdef-new.json
  .ecs-network.json
  .migration-task.json
  .migration-result.json
  .worker-taskdef-current.json
  .worker-env-source.json
  .worker-taskdef-new.json
)

cleanup_temp_files() {
  rm -f "${TEMP_FILES[@]}"
}

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

trap cleanup_temp_files EXIT
cleanup_temp_files

if ! command -v gh > /dev/null 2>&1; then
  error "GitHub CLI (gh) is required so deploys can verify green checks on origin/main."
  exit 1
fi

if ! gh auth status -h github.com > /dev/null 2>&1; then
  error "GitHub CLI is not authenticated. Run 'gh auth login' before deploying."
  exit 1
fi

git fetch origin main --quiet

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  error "Deploys must run from main. Current branch: $CURRENT_BRANCH"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  error "Working tree is not clean. Commit, stash, or remove local changes before deploying."
  git status --short
  exit 1
fi

LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  error "Local main is not exactly origin/main. Pull the latest main before deploying."
  exit 1
fi

CHECKS_JSON=$(gh run list --commit "$LOCAL_SHA" --limit 20 --json status,conclusion,workflowName)
if ! CHECK_REPORT=$(CHECKS_JSON="$CHECKS_JSON" node <<'NODE'
const runs = JSON.parse(process.env.CHECKS_JSON || "[]");
if (runs.length === 0) {
  console.log("No GitHub Actions runs found for origin/main; refusing deploy without a green CI signal.");
  process.exit(1);
}
const greenConclusions = new Set(["success", "skipped", "neutral"]);
const latestRunsByWorkflow = new Map();
for (const run of runs) {
  if (!latestRunsByWorkflow.has(run.workflowName)) {
    latestRunsByWorkflow.set(run.workflowName, run);
  }
}
const badRuns = [...latestRunsByWorkflow.values()].filter(
  (run) => run.status !== "completed" || !greenConclusions.has(run.conclusion)
);
if (badRuns.length > 0) {
  console.log(
    "GitHub Actions checks are not green:\n" +
      badRuns.map((run) => `- ${run.workflowName}: status=${run.status}, conclusion=${run.conclusion}`).join("\n")
  );
  process.exit(1);
}
console.log("ok");
NODE
); then
  error "$CHECK_REPORT"
  exit 1
fi

IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
success "Git deploy preflight OK: main@$IMAGE_TAG has green GitHub checks"
info "Image tag:   $IMAGE_TAG"

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

  # Step 4: Register a task-def revision pinned to the just-pushed image digest.
  # ECR tags (incl. :latest) are mutable — pinning by digest makes every revision
  # an exact, rollback-able image reference instead of "whatever :latest is now".
  info "Resolving image digest for tag ${IMAGE_TAG}..."
  DIGEST=$(aws ecr describe-images \
    --repository-name "${NAME}-api" \
    --image-ids imageTag="${IMAGE_TAG}" \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --region "$REGION")
  info "Digest: $DIGEST"

  info "Rendering task definition from the live service plus Terraform template..."
  CURRENT_API_TASK_DEF=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --query 'services[0].taskDefinition' \
    --output text \
    --region "$REGION")

  aws ecs describe-task-definition \
    --task-definition "$CURRENT_API_TASK_DEF" \
    --query taskDefinition \
    --output json \
    --region "$REGION" > .taskdef-current.json

  aws ecs describe-task-definition \
    --task-definition "${NAME}-api" \
    --query taskDefinition \
    --output json \
    --region "$REGION" > .taskdef-template.json

  # Relative paths so this works with Windows node under Git Bash too.
  ACCOUNT_ID="$ACCOUNT_ID" REGION="$REGION" PROJECT="$PROJECT" ENVIRONMENT="$ENV" IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e '
    const fs = require("fs");
    const td = JSON.parse(fs.readFileSync(".taskdef-current.json", "utf8"));
    const template = JSON.parse(fs.readFileSync(".taskdef-template.json", "utf8"));
    const readonly = ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"];
    readonly.forEach(k => delete td[k]);

    for (const key of ["family","taskRoleArn","executionRoleArn","networkMode","requiresCompatibilities","cpu","memory","runtimePlatform","ephemeralStorage"]) {
      if (template[key] !== undefined) td[key] = template[key];
    }

    function mergeNamed(base = [], overlay = []) {
      const merged = new Map();
      for (const item of base) merged.set(item.name, item);
      for (const item of overlay) merged.set(item.name, item);
      return [...merged.values()];
    }

    function dedupeEnvAgainstSecrets(container) {
      const secretNames = new Set((container.secrets || []).map(item => item.name));
      container.environment = (container.environment || []).filter(item => !secretNames.has(item.name));
    }

    function ssmParameterArn(name) {
      return `arn:aws:ssm:${process.env.REGION}:${process.env.ACCOUNT_ID}:parameter/${process.env.PROJECT}/${process.env.ENVIRONMENT}/${name}`;
    }

    function migratePlaintextSecrets(container) {
      const secureStringNames = ["ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"];
      const secretsByName = new Map((container.secrets || []).map(item => [item.name, item]));
      const envNames = new Set((container.environment || []).map(item => item.name));
      for (const name of secureStringNames) {
        if (envNames.has(name) || secretsByName.has(name)) {
          secretsByName.set(name, { name, valueFrom: ssmParameterArn(name) });
        }
      }
      container.secrets = [...secretsByName.values()];
      container.environment = (container.environment || []).filter(item => !secureStringNames.includes(item.name));
    }

    const container = td.containerDefinitions.find(c => c.name === "api") || td.containerDefinitions[0];
    const templateContainer = (template.containerDefinitions || []).find(c => c.name === "api") || template.containerDefinitions?.[0] || {};
    const liveEnvironment = container.environment || [];
    const liveSecrets = container.secrets || [];
    Object.assign(container, templateContainer);
    container.image = process.env.IMAGE_REF;
    container.environment = mergeNamed(liveEnvironment, templateContainer.environment);
    container.secrets = mergeNamed(liveSecrets, templateContainer.secrets);
    migratePlaintextSecrets(container);
    dedupeEnvAgainstSecrets(container);

    fs.writeFileSync(".taskdef-new.json", JSON.stringify(td));
  '

  NEW_REV=$(aws ecs register-task-definition \
    --cli-input-json file://.taskdef-new.json \
    --query 'taskDefinition.revision' \
    --output text \
    --region "$REGION")
  rm -f .taskdef-current.json .taskdef-template.json .taskdef-new.json
  success "Registered ${NAME}-api:${NEW_REV} (image pinned by digest)"

  # Step 5: Run migrations as an explicit one-off task before any service rollout.
  info "Resolving ECS network configuration for migration task..."
  aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration' \
    --output json \
    --region "$REGION" > .ecs-network.json

  NETWORK_CONFIG=$(node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(".ecs-network.json", "utf8"));
    if (!Array.isArray(cfg.subnets) || cfg.subnets.length === 0) {
      throw new Error("ECS service has no subnet network configuration");
    }
    const securityGroups = Array.isArray(cfg.securityGroups) ? cfg.securityGroups : [];
    const assignPublicIp = cfg.assignPublicIp || "DISABLED";
    console.log(`awsvpcConfiguration={subnets=[${cfg.subnets.join(",")}],securityGroups=[${securityGroups.join(",")}],assignPublicIp=${assignPublicIp}}`);
  ')

  info "Running startup migrations with ${NAME}-api:${NEW_REV}..."
  aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "${NAME}-api:${NEW_REV}" \
    --network-configuration "$NETWORK_CONFIG" \
    --overrides '{"containerOverrides":[{"name":"api","environment":[{"name":"RUN_MIGRATIONS_ONLY","value":"true"},{"name":"SCHEDULER_ENABLED","value":"false"}]}]}' \
    --region "$REGION" > .migration-task.json

  MIGRATION_TASK_ARN=$(node -e '
    const fs = require("fs");
    const result = JSON.parse(fs.readFileSync(".migration-task.json", "utf8"));
    if (result.failures?.length || !result.tasks?.[0]?.taskArn) {
      console.error(JSON.stringify(result.failures || result, null, 2));
      process.exit(1);
    }
    console.log(result.tasks[0].taskArn);
  ')

  aws ecs wait tasks-stopped \
    --cluster "$CLUSTER" \
    --tasks "$MIGRATION_TASK_ARN" \
    --region "$REGION"

  aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$MIGRATION_TASK_ARN" \
    --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason,logStream:logStreamName}' \
    --output json \
    --region "$REGION" > .migration-result.json

  MIGRATION_EXIT_CODE=$(node -e '
    const fs = require("fs");
    const result = JSON.parse(fs.readFileSync(".migration-result.json", "utf8"));
    console.log(result.exitCode ?? 1);
  ')
  if [[ "$MIGRATION_EXIT_CODE" != "0" ]]; then
    error "Migration task failed:"
    cat .migration-result.json
    rm -f .ecs-network.json .migration-task.json .migration-result.json
    exit 1
  fi
  rm -f .ecs-network.json .migration-task.json .migration-result.json
  success "Startup migrations completed"

  # Step 6: Point the API service at the new revision
  info "Updating ECS service to revision ${NEW_REV}..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "${NAME}-api:${NEW_REV}" \
    --region "$REGION" \
    --query 'service.{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' \
    --output table

  UPDATED_WORKER=false
  if [[ "$(ecs_service_status "$WORKER_SERVICE")" == "ACTIVE" ]]; then
    info "Rendering scheduler worker task definition from the current worker revision..."
    aws ecs describe-task-definition \
      --task-definition "$WORKER_SERVICE" \
      --query taskDefinition \
      --output json \
      --region "$REGION" > .worker-taskdef-current.json

    aws ecs describe-task-definition \
      --task-definition "${NAME}-api:${NEW_REV}" \
      --query taskDefinition \
      --output json \
      --region "$REGION" > .worker-env-source.json

    IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e '
      const fs = require("fs");
      const td = JSON.parse(fs.readFileSync(".worker-taskdef-current.json", "utf8"));
      const api = JSON.parse(fs.readFileSync(".worker-env-source.json", "utf8"));
      ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"].forEach(k => delete td[k]);

      function mergeNamed(base = [], overlay = []) {
        const merged = new Map();
        for (const item of base) merged.set(item.name, item);
        for (const item of overlay) merged.set(item.name, item);
        return [...merged.values()];
      }

      function dedupeEnvAgainstSecrets(container) {
        const secretNames = new Set((container.secrets || []).map(item => item.name));
        container.environment = (container.environment || []).filter(item => !secretNames.has(item.name));
      }

      const container = td.containerDefinitions.find(c => c.name === "scheduler-worker") || td.containerDefinitions[0];
      const apiContainer = (api.containerDefinitions || []).find(c => c.name === "api") || api.containerDefinitions?.[0] || {};
      container.image = process.env.IMAGE_REF;
      container.environment = mergeNamed(apiContainer.environment, container.environment);
      container.secrets = mergeNamed(apiContainer.secrets, container.secrets);
      dedupeEnvAgainstSecrets(container);
      fs.writeFileSync(".worker-taskdef-new.json", JSON.stringify(td));
    '

    WORKER_NEW_REV=$(aws ecs register-task-definition \
      --cli-input-json file://.worker-taskdef-new.json \
      --query 'taskDefinition.revision' \
      --output text \
      --region "$REGION")
    rm -f .worker-taskdef-current.json .worker-env-source.json .worker-taskdef-new.json
    success "Registered ${WORKER_SERVICE}:${WORKER_NEW_REV} (image pinned by digest)"

    info "Updating scheduler worker service to revision ${WORKER_NEW_REV}..."
    aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$WORKER_SERVICE" \
      --task-definition "${WORKER_SERVICE}:${WORKER_NEW_REV}" \
      --region "$REGION" \
      --query 'service.{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' \
      --output table
    UPDATED_WORKER=true
  else
    warn "Scheduler worker service not found; run Terraform before relying on multi-task API scale-out."
  fi

  if [[ "$SKIP_WAIT" == true ]]; then
    warn "Skipping ECS stabilization wait (--skip-wait)"
  else
    info "Waiting for ECS deployment to stabilize (this may take 2-5 minutes)..."
    if [[ "$UPDATED_WORKER" == true ]]; then
      aws ecs wait services-stable \
        --cluster "$CLUSTER" \
        --services "$SERVICE" "$WORKER_SERVICE" \
        --region "$REGION"
    else
      aws ecs wait services-stable \
        --cluster "$CLUSTER" \
        --services "$SERVICE" \
        --region "$REGION"
    fi
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

  # Step 3: Invalidate CloudFront. index.html is no-cache and references the hashed
  # asset bundles, so invalidating it + root is sufficient. MSYS_NO_PATHCONV=1 stops
  # Git Bash on Windows from rewriting the leading-slash "/index.html" "/" into
  # Windows paths (which CloudFront rejects as InvalidArgument); harmless elsewhere.
  info "Invalidating CloudFront cache..."
  MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/index.html" "/" \
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
