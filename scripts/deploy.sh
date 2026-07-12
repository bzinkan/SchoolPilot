#!/bin/bash
# ============================================================================
# SchoolPilot Deploy Script
# Works on macOS, Linux, and Windows (Git Bash / WSL)
#
# Usage:
#   ./scripts/deploy.sh                  # Deploy everything (backend + frontend)
#   ./scripts/deploy.sh --backend        # Backend only (Docker → ECR → ECS)
#   ./scripts/deploy.sh --frontend       # Frontend only (Vite build → S3 → CloudFront)
#   ./scripts/deploy.sh --skip-wait      # Non-production only; production refuses this flag
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
EMERGENCY_TASK_DEF_ARN=""
EMERGENCY_TASK_DEF_REVISION=""
WORKER_NEW_REV=""

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
AUTOSCALING_RESOURCE_ID="service/${CLUSTER}/${SERVICE}"
AUTOSCALING_DIMENSION="ecs:service:DesiredCount"

# These values are populated only while a production backend deploy owns the
# temporary Application Auto Scaling hold. Keeping the prior booleans separate
# avoids depending on JSON round-tripping across Bash/Windows process boundaries.
PRODUCTION_SCALING_HOLD_ACTIVE=false
PRODUCTION_SCALING_PRIOR_IN=""
PRODUCTION_SCALING_PRIOR_OUT=""
PRODUCTION_SCALING_PRIOR_SCHEDULED=""

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

production_service_snapshot() {
  AWS_MAX_ATTEMPTS=1 aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" "$WORKER_SERVICE" \
    --query 'services[].[serviceName,status,desiredCount,runningCount,pendingCount,length(deployments),taskDefinition,deployments[?status==`PRIMARY`]|[0].taskDefinition,deployments[?status==`PRIMARY`]|[0].rolloutState]' \
    --output text \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 2>/dev/null
}

normalize_task_definition_ref() {
  local ref="${1%$'\r'}"

  if [[ "$ref" =~ ^([A-Za-z0-9_-]+):([1-9][0-9]*)$ ]]; then
    printf '%s:%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    return 0
  fi

  if [[ "$ref" =~ ^arn:aws(-[a-z0-9-]+)?:ecs:[a-z0-9-]+:[0-9]{12}:task-definition/([A-Za-z0-9_-]+):([1-9][0-9]*)$ ]]; then
    printf '%s:%s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}"
    return 0
  fi

  return 1
}

validate_production_service_snapshot() {
  local snapshot="$1"
  local expected_api_ref="${2:-}"
  local expected_worker_ref="${3:-}"
  local expected_api=""
  local expected_worker=""
  local service_name status desired running pending deployment_count service_task_definition primary_task_definition rollout_state extra
  local normalized_service_task_definition normalized_primary_task_definition
  local api_seen=0
  local worker_seen=0
  local api_desired=""

  if [[ -n "$expected_api_ref" || -n "$expected_worker_ref" ]]; then
    if [[ -z "$expected_api_ref" || -z "$expected_worker_ref" ]] ||
       ! expected_api=$(normalize_task_definition_ref "$expected_api_ref") ||
       ! expected_worker=$(normalize_task_definition_ref "$expected_worker_ref"); then
      error "Expected production task-definition revisions were missing or malformed; refusing the backend deployment."
      return 1
    fi
  fi

  while IFS=$'\t' read -r service_name status desired running pending deployment_count service_task_definition primary_task_definition rollout_state extra; do
    rollout_state="${rollout_state%$'\r'}"
    extra="${extra%$'\r'}"

    if [[ -z "$service_name" || -n "$extra" ||
          ! "$desired" =~ ^(0|[1-9][0-9]*)$ ||
          ! "$running" =~ ^(0|[1-9][0-9]*)$ ||
          ! "$pending" =~ ^(0|[1-9][0-9]*)$ ||
          ! "$deployment_count" =~ ^(0|[1-9][0-9]*)$ ]]; then
      error "Production ECS service state was malformed or ambiguous; refusing the backend deployment."
      return 1
    fi

    if ! normalized_service_task_definition=$(normalize_task_definition_ref "$service_task_definition") ||
       ! normalized_primary_task_definition=$(normalize_task_definition_ref "$primary_task_definition"); then
      error "Production ECS service ${service_name} returned a malformed task-definition reference; refusing the backend deployment."
      return 1
    fi

    if [[ "$normalized_service_task_definition" != "$normalized_primary_task_definition" ]]; then
      error "Production ECS service ${service_name} and its PRIMARY deployment disagree on task definition; refusing the backend deployment."
      return 1
    fi

    if [[ "$status" != "ACTIVE" || "$running" != "$desired" || "$pending" != "0" ||
          "$deployment_count" != "1" || "$rollout_state" != "COMPLETED" ]]; then
      error "Production ECS service ${service_name} is not stable (status=${status}, desired=${desired}, running=${running}, pending=${pending}, deployments=${deployment_count}, rollout=${rollout_state}); refusing the backend deployment."
      return 1
    fi

    case "$service_name" in
      "$SERVICE")
        api_seen=$((api_seen + 1))
        api_desired="$desired"
        if [[ -n "$expected_api" && "$normalized_service_task_definition" != "$expected_api" ]]; then
          error "Production API completed an unexpected task definition (${normalized_service_task_definition}; expected ${expected_api}); refusing the backend deployment."
          return 1
        fi
        if [[ "$desired" != "1" && "$desired" != "2" ]]; then
          error "Production API desiredCount is ${desired}; backend deploys require desiredCount 1 or 2 so rolling database connections stay below the launch gate."
          return 1
        fi
        ;;
      "$WORKER_SERVICE")
        worker_seen=$((worker_seen + 1))
        if [[ -n "$expected_worker" && "$normalized_service_task_definition" != "$expected_worker" ]]; then
          error "Production scheduler worker completed an unexpected task definition (${normalized_service_task_definition}; expected ${expected_worker}); refusing the backend deployment."
          return 1
        fi
        if [[ "$desired" != "1" ]]; then
          error "Production scheduler worker desiredCount is ${desired}; backend deploys require exactly one worker so rolling database connections stay below the launch gate."
          return 1
        fi
        ;;
      *)
        error "Unexpected ECS service ${service_name} appeared in the production capacity check; refusing the backend deployment."
        return 1
        ;;
    esac
  done <<< "$snapshot"

  if [[ "$api_seen" != "1" || "$worker_seen" != "1" ]]; then
    error "Production capacity check did not return exactly one API and one scheduler worker service; refusing the backend deployment."
    return 1
  fi

  PRODUCTION_PREFLIGHT_API_DESIRED="$api_desired"
}

production_backend_capacity_preflight() {
  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ]]; then
    return 0
  fi

  if [[ "$SKIP_WAIT" == true ]]; then
    error "Production backend deploys cannot use --skip-wait because the autoscaling hold must remain through ECS stabilization."
    return 1
  fi

  local phase="${1:-before deployment}"
  local service_snapshot
  info "Checking production API and scheduler capacity ${phase}..."
  if ! service_snapshot=$(production_service_snapshot); then
    error "Could not read production ECS service state; refusing the backend deployment."
    return 1
  fi

  if ! validate_production_service_snapshot "$service_snapshot"; then
    return 1
  fi

  success "Production backend capacity preflight OK: API desiredCount=${PRODUCTION_PREFLIGHT_API_DESIRED}, worker desiredCount=1, both stable"
}

wait_for_production_backend_strict_stability() {
  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ]]; then
    return 0
  fi

  local expected_api_ref="${1:-}"
  local expected_worker_ref="${2:-}"
  local max_attempts="${3:-30}"
  local interval_seconds="${4:-2}"
  local attempt service_snapshot="" last_snapshot_read_ok=false

  if [[ -z "$expected_api_ref" || -z "$expected_worker_ref" ]] ||
     ! normalize_task_definition_ref "$expected_api_ref" > /dev/null ||
     ! normalize_task_definition_ref "$expected_worker_ref" > /dev/null; then
    error "Production ECS strict-stability polling requires exact API and worker task-definition revisions; refusing the backend deployment."
    return 1
  fi

  if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ || ! "$interval_seconds" =~ ^(0|[1-9][0-9]*)$ ]]; then
    error "Production ECS strict-stability polling bounds are invalid; refusing the backend deployment."
    return 1
  fi

  info "Confirming strict production ECS stability with at most ${max_attempts} bounded observations (${interval_seconds}s interval; each AWS call has 3s connect and 5s read limits)..."
  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    service_snapshot=""
    last_snapshot_read_ok=false
    if service_snapshot=$(production_service_snapshot); then
      last_snapshot_read_ok=true
      # The ECS services-stable waiter can return a few seconds before the
      # rolloutState projection converges. Reuse the exact strict validator,
      # but suppress its fail-closed diagnostic until the bounded poll expires.
      if { validate_production_service_snapshot "$service_snapshot" "$expected_api_ref" "$expected_worker_ref"; } > /dev/null 2>&1; then
        success "Strict production ECS stability verified: API desiredCount=${PRODUCTION_PREFLIGHT_API_DESIRED}, worker desiredCount=1, one COMPLETED deployment each"
        return 0
      fi
    fi

    if [[ "$attempt" != "$max_attempts" ]]; then
      info "Production ECS rollout metadata has not fully converged (attempt ${attempt}/${max_attempts}); retrying in ${interval_seconds}s..."
      sleep "$interval_seconds"
    fi
  done

  # Surface the final strict-validator detail when AWS returned a snapshot;
  # otherwise distinguish a control-plane read failure. In either case the
  # caller exits while the autoscaling hold is still active, so the EXIT trap
  # restores the exact prior suspended state.
  if [[ "$last_snapshot_read_ok" == true ]]; then
    validate_production_service_snapshot "$service_snapshot" "$expected_api_ref" "$expected_worker_ref" || true
  else
    error "The final production ECS describe-services call failed during strict-stability polling."
  fi
  error "Production ECS services did not reach one COMPLETED deployment each before the bounded deadline; refusing to report deployment success and requiring autoscaling recovery."
  return 1
}

production_scaling_state_snapshot() {
  aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "$AUTOSCALING_RESOURCE_ID" \
    --scalable-dimension "$AUTOSCALING_DIMENSION" \
    --query 'ScalableTargets[0].[SuspendedState.DynamicScalingInSuspended,SuspendedState.DynamicScalingOutSuspended,SuspendedState.ScheduledScalingSuspended]' \
    --output text \
    --region "$REGION" 2>/dev/null
}

normalize_production_scaling_state() {
  local raw="$1"
  local scale_in scale_out scheduled extra

  if [[ "$raw" == *$'\n'* ]]; then
    return 1
  fi

  read -r scale_in scale_out scheduled extra <<< "$raw"
  scheduled="${scheduled%$'\r'}"
  extra="${extra%$'\r'}"
  if [[ -z "$scale_in" || -z "$scale_out" || -z "$scheduled" || -n "$extra" ]]; then
    return 1
  fi

  case "$scale_in" in
    True|true) scale_in=true ;;
    False|false) scale_in=false ;;
    *) return 1 ;;
  esac
  case "$scale_out" in
    True|true) scale_out=true ;;
    False|false) scale_out=false ;;
    *) return 1 ;;
  esac
  case "$scheduled" in
    True|true) scheduled=true ;;
    False|false) scheduled=false ;;
    *) return 1 ;;
  esac

  printf '%s %s %s\n' "$scale_in" "$scale_out" "$scheduled"
}

set_production_scaling_state() {
  local scale_in="$1"
  local scale_out="$2"
  local scheduled="$3"

  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --resource-id "$AUTOSCALING_RESOURCE_ID" \
    --scalable-dimension "$AUTOSCALING_DIMENSION" \
    --suspended-state "DynamicScalingInSuspended=${scale_in},DynamicScalingOutSuspended=${scale_out},ScheduledScalingSuspended=${scheduled}" \
    --region "$REGION" > /dev/null
}

wait_for_production_scaling_state() {
  local expected="$1 $2 $3"
  local attempt raw normalized

  # Application Auto Scaling updates are normally visible immediately, but use
  # a bounded 20-second observation window for control-plane propagation.
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    raw=""
    normalized=""
    if raw=$(production_scaling_state_snapshot) &&
       normalized=$(normalize_production_scaling_state "$raw") &&
       [[ "$normalized" == "$expected" ]]; then
      return 0
    fi
    if [[ "$attempt" != "10" ]]; then
      sleep 2
    fi
  done
  return 1
}

acquire_production_scaling_hold() {
  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ]]; then
    return 0
  fi
  if [[ "$PRODUCTION_SCALING_HOLD_ACTIVE" == true ]]; then
    error "Production autoscaling hold is already active; refusing to overwrite its recovery state."
    return 1
  fi

  local raw prior
  if ! raw=$(production_scaling_state_snapshot); then
    error "Could not read the production API autoscaling suspended state; refusing the service rollout."
    return 1
  fi
  if ! prior=$(normalize_production_scaling_state "$raw"); then
    error "Production API autoscaling suspended state was missing or ambiguous; refusing the service rollout."
    return 1
  fi
  read -r PRODUCTION_SCALING_PRIOR_IN PRODUCTION_SCALING_PRIOR_OUT PRODUCTION_SCALING_PRIOR_SCHEDULED <<< "$prior"

  # Mark the hold active before the mutating request. If the client loses the
  # response after AWS applied it, the EXIT trap still restores the captured state.
  PRODUCTION_SCALING_HOLD_ACTIVE=true
  info "Suspending production API dynamic scaling while preserving the prior scheduled-scaling state..."
  if ! set_production_scaling_state true true "$PRODUCTION_SCALING_PRIOR_SCHEDULED"; then
    error "Could not suspend production API autoscaling; refusing the service rollout."
    return 1
  fi
  if ! wait_for_production_scaling_state true true "$PRODUCTION_SCALING_PRIOR_SCHEDULED"; then
    error "Production API autoscaling hold could not be verified; refusing the service rollout."
    return 1
  fi
  success "Production API dynamic-scaling hold verified; scheduled-scaling state preserved"

  # The first check happens before Docker. This second snapshot closes the
  # build/push window and is protected from target-tracking drift. The reviewed
  # scheduled actions remain live and can move only between one and two tasks.
  if ! production_backend_capacity_preflight "under the autoscaling hold"; then
    error "Production ECS capacity changed after the initial preflight; refusing the migration and service rollout."
    return 1
  fi
}

restore_production_scaling_hold() {
  if [[ "$PRODUCTION_SCALING_HOLD_ACTIVE" != true ]]; then
    return 0
  fi

  info "Restoring the exact prior production API autoscaling suspended state..."
  if ! set_production_scaling_state \
    "$PRODUCTION_SCALING_PRIOR_IN" \
    "$PRODUCTION_SCALING_PRIOR_OUT" \
    "$PRODUCTION_SCALING_PRIOR_SCHEDULED"; then
    error "Could not restore the prior production API autoscaling suspended state."
    return 1
  fi
  if ! wait_for_production_scaling_state \
    "$PRODUCTION_SCALING_PRIOR_IN" \
    "$PRODUCTION_SCALING_PRIOR_OUT" \
    "$PRODUCTION_SCALING_PRIOR_SCHEDULED"; then
    error "Prior production API autoscaling suspended state was not observable after restoration."
    return 1
  fi

  PRODUCTION_SCALING_HOLD_ACTIVE=false
  PRODUCTION_SCALING_PRIOR_IN=""
  PRODUCTION_SCALING_PRIOR_OUT=""
  PRODUCTION_SCALING_PRIOR_SCHEDULED=""
  success "Production API autoscaling suspended state restored"
}

TEMP_FILES=(
  .taskdef-current.json
  .taskdef-template.json
  .taskdef-new.json
  .taskdef-emergency.json
  .taskdef-emergency-registered.json
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

deploy_exit_cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "$PRODUCTION_SCALING_HOLD_ACTIVE" == true ]]; then
    warn "Deploy exited while the production autoscaling hold was active; attempting recovery..."
    if ! restore_production_scaling_hold; then
      error "EXIT recovery could not restore production API autoscaling. Manual recovery is required immediately."
      exit_code=1
    fi
  fi

  cleanup_temp_files
  exit "$exit_code"
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

trap deploy_exit_cleanup EXIT
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

# A 200% API/worker rollout is safe under the reviewed 150-connection launch
# gate only while the API is stable at one or two tasks and the singleton
# worker is stable at one task. This check runs before Docker/ECR/ECS work and
# fails closed if ECS cannot provide one unambiguous two-service snapshot.
production_backend_capacity_preflight

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
  success "Registered ${NAME}-api:${NEW_REV} (image pinned by digest)"

  # Pre-register an unused, digest-identical OOM recovery target. It is cloned
  # from the just-rendered API revision so environment variables, secrets,
  # roles, logging, health checks, and runtime settings stay exactly aligned.
  # Only the family and Fargate task size differ; no service is pointed at it.
  info "Rendering 512 CPU / 2048 MiB API OOM emergency revision..."
  EMERGENCY_FAMILY="${NAME}-api-emergency" IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e '
    const fs = require("fs");
    const source = JSON.parse(fs.readFileSync(".taskdef-new.json", "utf8"));
    const emergency = structuredClone(source);
    const container = (emergency.containerDefinitions || []).find(c => c.name === "api") || emergency.containerDefinitions?.[0];

    if (!container) {
      throw new Error("Rendered API task definition has no container");
    }
    if (container.image !== process.env.IMAGE_REF || !container.image.includes("@sha256:")) {
      throw new Error("Emergency task definition must use the just-pushed digest-pinned API image");
    }

    emergency.family = process.env.EMERGENCY_FAMILY;
    emergency.cpu = "512";
    emergency.memory = "2048";
    // The live task currently relies on the task-level ceiling. If a future
    // revision adds a hard container cap, carrying it into the OOM target
    // would silently defeat the 2 GiB recovery posture.
    delete container.memory;
    fs.writeFileSync(".taskdef-emergency.json", JSON.stringify(emergency));
  '

  EMERGENCY_TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://.taskdef-emergency.json \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text \
    --region "$REGION")
  EMERGENCY_TASK_DEF_REVISION="${EMERGENCY_TASK_DEF_ARN##*:}"
  if [[ ! "$EMERGENCY_TASK_DEF_REVISION" =~ ^[0-9]+$ ]]; then
    error "Could not determine the registered emergency task-definition revision from: $EMERGENCY_TASK_DEF_ARN"
    exit 1
  fi

  aws ecs describe-task-definition \
    --task-definition "$EMERGENCY_TASK_DEF_ARN" \
    --query taskDefinition \
    --output json \
    --region "$REGION" > .taskdef-emergency-registered.json
  EMERGENCY_FAMILY="${NAME}-api-emergency" IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e '
    const fs = require("fs");
    const registered = JSON.parse(fs.readFileSync(".taskdef-emergency-registered.json", "utf8"));
    const container = (registered.containerDefinitions || []).find(c => c.name === "api") || registered.containerDefinitions?.[0];
    if (registered.family !== process.env.EMERGENCY_FAMILY || registered.cpu !== "512" || registered.memory !== "2048") {
      throw new Error("Registered emergency task definition does not have the reviewed family and 512/2048 task size");
    }
    if (!container || container.image !== process.env.IMAGE_REF || !container.image.includes("@sha256:")) {
      throw new Error("Registered emergency task definition is not pinned to the deployed API image digest");
    }
    if (container.memory !== undefined && Number(container.memory) < 2048) {
      throw new Error("Registered emergency container retains a lower hard memory ceiling");
    }
  '

  rm -f .taskdef-current.json .taskdef-template.json .taskdef-new.json .taskdef-emergency.json .taskdef-emergency-registered.json
  success "OOM emergency target registered but not deployed: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION})"
  info "OOM recovery command: aws ecs update-service --cluster ${CLUSTER} --service ${SERVICE} --task-definition ${EMERGENCY_TASK_DEF_ARN} --region ${REGION}"

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

  # Acquire the hold only after the slow image and task-definition work, then
  # keep it through the one-off migration and both ECS service deployments.
  # The helper rechecks API/worker stability after scaling is suspended.
  acquire_production_scaling_hold

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
  production_backend_capacity_preflight "after migration under the autoscaling hold"
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
    if [[ "$ENV" == "production" ]]; then
      error "Production scheduler worker disappeared after the guarded capacity check; refusing to complete the rollout."
      exit 1
    fi
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

  # Keep dynamic scaling suspended until ECS itself reports a single, completed
  # deployment for both services at the reviewed task counts. The standard ECS
  # waiter can return just before rolloutState converges, so a production-only,
  # bounded strict poll closes that control-plane propagation window. Scheduled
  # scaling remains in its captured state so a 06:00/10:00 action cannot be skipped.
  wait_for_production_backend_strict_stability \
    "${NAME}-api:${NEW_REV}" \
    "${WORKER_SERVICE}:${WORKER_NEW_REV}"

  if ! restore_production_scaling_hold; then
    error "Backend deployment stabilized, but autoscaling restoration failed; failing the deploy and retrying restoration from the EXIT trap."
    exit 1
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
if [[ "$DEPLOY_BACKEND" == true && -n "$EMERGENCY_TASK_DEF_ARN" ]]; then
  echo "  OOM target: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION}, 512 CPU / 2048 MiB; not deployed)"
fi
[[ "$DEPLOY_FRONTEND" == true ]] && echo "  Frontend: S3 synced, CloudFront invalidated"
echo ""
