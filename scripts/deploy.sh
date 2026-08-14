#!/bin/bash
# ============================================================================
# SchoolPilot Deploy Script
# Works on macOS, Linux, and Windows (Git Bash / WSL)
#
# Usage:
#   ./scripts/deploy.sh                  # Deploy everything (backend + frontend)
#   ./scripts/deploy.sh --backend        # Backend only (Docker → ECR → ECS)
#   ./scripts/deploy.sh --frontend       # Frontend only (Vite build → S3 → CloudFront)
#   ./scripts/deploy.sh production --backend --activate-emergency
#                                       # Backend only; activate the newly registered 512/2048 API revision
#   ./scripts/deploy.sh production --backend --activate-emergency \
#     --enable-rls-table passpilot_grade_students
#                                       # One reviewed release only; add one tenant table without changing the master switch or existing entries
#   ./scripts/deploy.sh production --backend --activate-emergency \
#     --classpilot-tile-auth-plan-gate --classpilot-tile-auth-plan-rehearsal
#                                       # Build/register inactive exact candidates and run the preflight/full gate only
#   ./scripts/deploy.sh production --backend --activate-emergency \
#     --classpilot-tile-auth-plan-observation
#                                       # Build/register inactive exact candidates and run one read-only base observation only
#   ./scripts/deploy.sh production --backend --activate-emergency \
#     --classpilot-tile-auth-plan-gate \
#     --reuse-classpilot-tile-auth-plan-rehearsal <private-receipt-path> \
#     --expected-classpilot-tile-auth-plan-rehearsal-sha256 <64-hex>
#                                       # Consume one fresh rehearsal receipt and deploy only its exact candidates
#   ./scripts/deploy.sh production --backend --activate-emergency \
#     --capacity-acceptance-release
#                                       # Historical capacity flag; rejected while authorization is paused
#   ./scripts/deploy.sh production --frontend \
#     --capacity-acceptance-frontend-sha <40-hex-sha>
#                                       # Historical capacity flag; rejected while authorization is paused
#   ./scripts/deploy.sh production --backend --same-image-networking-stage PublicEcs \
#     --expected-app-sha <40-hex-sha> --expected-image-digest sha256:<64-hex> \
#     --expected-api-task-definition <full-arn> --expected-worker-task-definition <full-arn> \
#     --expected-network-config-sha256 <64-hex>
#                                       # Networking-only fresh deployment; never builds or publishes an image
#   ./scripts/deploy.sh --skip-wait      # Non-production only; production refuses this flag
#   ./scripts/deploy.sh production       # Explicit environment (default: production)
#   ./scripts/deploy.sh --tag abc123     # Override default git-SHA image tag
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CAPACITY_ACCEPTANCE_AUTHORIZATION_PATH="$SCRIPT_DIR/load/capacity-acceptance-authorization.json"

# --- Parse arguments ---
ENV="production"
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
SKIP_WAIT=false
ACTIVATE_EMERGENCY=false
ENABLE_RLS_TABLE=""
RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=false
RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=false
CAPACITY_ACCEPTANCE_RELEASE=false
CAPACITY_ACCEPTANCE_FRONTEND_SHA=""
CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD_SHA256=""
REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=""
EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256=""
SAME_IMAGE_NETWORKING_STAGE=""
EXPECTED_APP_SHA=""
EXPECTED_IMAGE_DIGEST=""
EXPECTED_API_TASK_DEFINITION=""
EXPECTED_WORKER_TASK_DEFINITION=""
SAME_IMAGE_API_TASK_DEFINITION=""
SAME_IMAGE_WORKER_TASK_DEFINITION=""
SAME_IMAGE_NETWORK_HASH=""
SAME_IMAGE_BOUND_NETWORK_HASH=""
EXPECTED_NETWORK_CONFIG_SHA256=""
SAME_IMAGE_SERVICE_MUTATION_STARTED=false
SAME_IMAGE_SAFE_TERMINAL_REACHED=false
SAME_IMAGE_RECOVERY_MAX_ATTEMPTS=30
SAME_IMAGE_RECOVERY_POLL_SECONDS=2
IMAGE_TAG=""
EMERGENCY_TASK_DEF_ARN=""
EMERGENCY_TASK_DEF_REVISION=""
API_ROLLOUT_TASK_DEF=""
WORKER_NEW_REV=""
WORKER_CANDIDATE_TASK_DEF=""
MIGRATION_TASK_WAIT_SECONDS=3600
MIGRATION_TASK_POLL_SECONDS=15
MIGRATION_TASK_STOP_WAIT_SECONDS=300
TILE_AUTH_PLAN_TASK_WAIT_SECONDS=900
TILE_AUTH_PLAN_TASK_POLL_SECONDS=5
TILE_AUTH_PLAN_TASK_STOP_WAIT_SECONDS=120
TILE_AUTH_PLAN_LOG_WAIT_SECONDS=60
TILE_AUTH_PLAN_LOG_POLL_SECONDS=3
TILE_AUTH_PLAN_OBSERVATION_EVIDENCE_DEADLINE_MS=300000

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)  DEPLOY_FRONTEND=false; shift ;;
    --frontend) DEPLOY_BACKEND=false; shift ;;
    --activate-emergency) ACTIVATE_EMERGENCY=true; shift ;;
    --enable-rls-table)
      [[ $# -ge 2 ]] || { echo "--enable-rls-table requires a reviewed table name"; exit 1; }
      [[ -z "$ENABLE_RLS_TABLE" ]] || { echo "--enable-rls-table may be specified only once"; exit 1; }
      ENABLE_RLS_TABLE="$2"
      shift 2
      ;;
    --classpilot-tile-auth-plan-gate) RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true; shift ;;
    --classpilot-tile-auth-plan-rehearsal)
      RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL=true
      shift
      ;;
    --classpilot-tile-auth-plan-observation)
      RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION=true
      shift
      ;;
    --capacity-acceptance-release)
      CAPACITY_ACCEPTANCE_RELEASE=true
      RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE=true
      shift
      ;;
    --capacity-acceptance-frontend-sha)
      [[ $# -ge 2 ]] || { echo "--capacity-acceptance-frontend-sha requires a full 40-hex SHA"; exit 1; }
      CAPACITY_ACCEPTANCE_FRONTEND_SHA="$2"
      shift 2
      ;;
    --reuse-classpilot-tile-auth-plan-rehearsal)
      [[ $# -ge 2 ]] || { echo "--reuse-classpilot-tile-auth-plan-rehearsal requires an absolute private receipt path"; exit 1; }
      REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL="$2"
      shift 2
      ;;
    --expected-classpilot-tile-auth-plan-rehearsal-sha256)
      [[ $# -ge 2 ]] || { echo "--expected-classpilot-tile-auth-plan-rehearsal-sha256 requires a 64-hex SHA-256"; exit 1; }
      EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256="$2"
      shift 2
      ;;
    --same-image-networking-stage)
      [[ $# -ge 2 ]] || { echo "--same-image-networking-stage requires PublicEcs or NatRemoved"; exit 1; }
      SAME_IMAGE_NETWORKING_STAGE="$2"
      DEPLOY_FRONTEND=false
      shift 2
      ;;
    --expected-app-sha)
      [[ $# -ge 2 ]] || { echo "--expected-app-sha requires a value"; exit 1; }
      EXPECTED_APP_SHA="$2"; shift 2
      ;;
    --expected-image-digest)
      [[ $# -ge 2 ]] || { echo "--expected-image-digest requires a value"; exit 1; }
      EXPECTED_IMAGE_DIGEST="$2"; shift 2
      ;;
    --expected-api-task-definition)
      [[ $# -ge 2 ]] || { echo "--expected-api-task-definition requires a value"; exit 1; }
      EXPECTED_API_TASK_DEFINITION="$2"; shift 2
      ;;
    --expected-worker-task-definition)
      [[ $# -ge 2 ]] || { echo "--expected-worker-task-definition requires a value"; exit 1; }
      EXPECTED_WORKER_TASK_DEFINITION="$2"; shift 2
      ;;
    --expected-network-config-sha256)
      [[ $# -ge 2 ]] || { echo "--expected-network-config-sha256 requires a value"; exit 1; }
      EXPECTED_NETWORK_CONFIG_SHA256="$2"; shift 2
      ;;
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
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION=""
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION=""
PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN=""
PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN=""
PRODUCTION_ROLLBACK_API_TASK_DEFINITION=""
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION=""
PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN=""
PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN=""
API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN=""
WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN=""
STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN=""
TILE_AUTH_PLAN_PRE_IDENTITY_SHA256=""
TILE_AUTH_PLAN_PRE_QUERY_IDENTIFIER_SHA256=""
TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH_SHA256=""
TILE_AUTH_PLAN_IDENTITY_RECEIPT_SHA256=""
TILE_AUTH_PLAN_PREFLIGHT_EVENTS_JSON=""
TILE_AUTH_PLAN_PREDEPLOY_EVENTS_JSON=""
TILE_AUTH_PLAN_PREFLIGHT_EVIDENCE_JSON=""
TILE_AUTH_PLAN_PREDEPLOY_REPORT_JSON=""
TILE_AUTH_PLAN_REHEARSAL_RECEIPT_PATH=""
TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_CONSUMED_NETWORK_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_IDENTITY_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_QUERY_IDENTIFIER_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED=false
TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256=""
TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_TERMINAL=false
TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=false
TILE_AUTH_PLAN_OBSERVATION_ID=""
TILE_AUTH_PLAN_OBSERVATION_TASK_ARN=""
TILE_AUTH_PLAN_OBSERVATION_TASK_EXIT_CODE=""
TILE_AUTH_PLAN_OBSERVATION_TASK_STATE=""
TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON=""
TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256=""
TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256=""
TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON=""
TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON=""
TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT=""
TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT=""
TILE_AUTH_PLAN_OBSERVATION_TASK_PATH=""
TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH=""
TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH=""
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH=""
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256=""
TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_ADMITTED=false
TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED=false
TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH=""
TILE_AUTH_PLAN_OBSERVATION_PACKET_SHA256=""
TILE_AUTH_PLAN_OBSERVATION_OUTCOME=""
TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID=""
TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH=""
TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_SHA256=""
CAPACITY_ACCEPTANCE_NETWORK_SHA256=""
CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=false
CLASSPILOT_TILE_AUTH_SAFE_TERMINAL_REACHED=false

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

# The stock `aws ecs wait tasks-stopped` waiter gives up after roughly ten
# minutes. Online index work can legitimately span more than one bounded SQL
# statement, so that waiter can abandon a still-running migration task. Keep
# observing the exact task for up to one hour. If the controller deadline is
# reached, request a stop and observe it for at most five additional minutes.
# Production service rollout must never begin while migration DDL is unobserved,
# but a task that never reports STOPPED must not strand the autoscaling hold.
wait_for_migration_task_stopped() {
  local task_arn="$1"
  local deadline=$((SECONDS + MIGRATION_TASK_WAIT_SECONDS))
  local status=""
  local stop_requested=false
  local deadline_exceeded=false
  local deadline_announced=false
  local stop_observation_deadline=-1

  while true; do
    if (( SECONDS >= deadline )); then
      deadline_exceeded=true
      if (( stop_observation_deadline < 0 )); then
        stop_observation_deadline=$((SECONDS + MIGRATION_TASK_STOP_WAIT_SECONDS))
      fi
    fi
    if status=$(aws ecs describe-tasks \
      --cluster "$CLUSTER" \
      --tasks "$task_arn" \
      --query 'tasks[0].lastStatus' \
      --output text \
      --cli-connect-timeout 10 \
      --cli-read-timeout 30 \
      --region "$REGION" 2>/dev/null); then
      if [[ "$status" == "STOPPED" ]]; then
        if [[ "$deadline_exceeded" == true ]]; then
          return 124
        fi
        return 0
      fi
    else
      warn "Could not read migration task status; retaining observation and retrying. Task: ${task_arn}"
    fi

    if [[ "$deadline_exceeded" == true ]]; then
      if [[ "$stop_requested" != true ]]; then
        if [[ "$deadline_announced" != true ]]; then
          error "Migration controller deadline (${MIGRATION_TASK_WAIT_SECONDS}s) reached; stopping task ${task_arn}."
          deadline_announced=true
        fi
        if aws ecs stop-task \
          --cluster "$CLUSTER" \
          --task "$task_arn" \
          --reason "SchoolPilot migration controller deadline" \
          --cli-connect-timeout 10 \
          --cli-read-timeout 30 \
          --region "$REGION" > .migration-stop.json 2>/dev/null; then
          stop_requested=true
        else
          warn "Migration stop request was not accepted yet; continuing to observe and retry. Task: ${task_arn}"
        fi
      fi
    fi

    if (( stop_observation_deadline >= 0 && SECONDS >= stop_observation_deadline )); then
      error "Migration task ${task_arn} did not report STOPPED within ${MIGRATION_TASK_STOP_WAIT_SECONDS}s after the stop deadline."
      return 125
    fi

    sleep "$MIGRATION_TASK_POLL_SECONDS"
  done
}

# The authorization plan check is deliberately shorter than a migration task.
# Observe it for fifteen minutes, request a stop at the controller deadline,
# and keep observing for at most two more minutes. The caller has not acquired
# the autoscaling hold or started a migration/service mutation at this point.
wait_for_classpilot_tile_auth_plan_task_stopped() {
  local task_arn="$1"
  local deadline=$((SECONDS + TILE_AUTH_PLAN_TASK_WAIT_SECONDS))
  local status=""
  local stop_requested=false
  local deadline_exceeded=false
  local stop_observation_deadline=-1

  while true; do
    if (( SECONDS >= deadline )); then
      deadline_exceeded=true
      if (( stop_observation_deadline < 0 )); then
        stop_observation_deadline=$((SECONDS + TILE_AUTH_PLAN_TASK_STOP_WAIT_SECONDS))
      fi
    fi

    if status=$(aws ecs describe-tasks \
      --cluster "$CLUSTER" \
      --tasks "$task_arn" \
      --query 'tasks[0].lastStatus' \
      --output text \
      --cli-connect-timeout 10 \
      --cli-read-timeout 30 \
      --region "$REGION" \
      --no-cli-pager 2>/dev/null); then
      status="${status%$'\r'}"
      if [[ "$status" == "STOPPED" ]]; then
        if [[ "$deadline_exceeded" == true ]]; then
          return 124
        fi
        return 0
      fi
    else
      warn "Could not read the ClassPilot tile authorization plan task status; retaining bounded observation."
    fi

    if [[ "$deadline_exceeded" == true && "$stop_requested" != true ]]; then
      if aws ecs stop-task \
        --cluster "$CLUSTER" \
        --task "$task_arn" \
        --reason "SchoolPilot tile authorization plan controller deadline" \
        --cli-connect-timeout 10 \
        --cli-read-timeout 30 \
        --region "$REGION" \
        --no-cli-pager > /dev/null 2>&1; then
        stop_requested=true
      else
        warn "The ClassPilot tile authorization plan stop request was not accepted yet; retrying within the bounded stop window."
      fi
    fi

    if (( stop_observation_deadline >= 0 && SECONDS >= stop_observation_deadline )); then
      return 125
    fi

    sleep "$TILE_AUTH_PLAN_TASK_POLL_SECONDS"
  done
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
  local api_task_definition=""
  local worker_task_definition=""
  local api_task_definition_arn=""
  local worker_task_definition_arn=""

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

    if [[ ! "$service_task_definition" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ||
          ! "$primary_task_definition" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]]; then
      error "Production ECS service ${service_name} did not return exact task-definition ARNs in the expected account and region; refusing the backend deployment."
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
        api_task_definition="$normalized_service_task_definition"
        api_task_definition_arn="$service_task_definition"
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
        worker_task_definition="$normalized_service_task_definition"
        worker_task_definition_arn="$service_task_definition"
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
  PRODUCTION_PREFLIGHT_API_TASK_DEFINITION="$api_task_definition"
  PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION="$worker_task_definition"
  PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN="$api_task_definition_arn"
  PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN="$worker_task_definition_arn"
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

production_tzif_date_at_epoch() {
  local tzif_path="$1"
  local epoch="$2"
  local format="$3"
  if TZ=":$tzif_path" date --date="@${epoch}" "$format" 2>/dev/null; then
    return 0
  fi
  TZ=":$tzif_path" date -r "$epoch" "$format" 2>/dev/null
}

production_eastern_tzif_path() {
  local candidate winter summer
  for candidate in \
    "/usr/share/zoneinfo/America/New_York" \
    "/mingw64/share/zoneinfo/America/New_York"; do
    if [[ ! -f "$candidate" ]]; then
      continue
    fi
    if ! winter=$(production_tzif_date_at_epoch "$candidate" "1768478400" '+%z %Z') ||
       ! summer=$(production_tzif_date_at_epoch "$candidate" "1784116800" '+%z %Z'); then
      continue
    fi
    if [[ "$winter" == "-0500 EST" && "$summer" == "-0400 EDT" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

production_eastern_weekday_hhmm() {
  local tzif_path
  if ! tzif_path=$(production_eastern_tzif_path); then
    return 1
  fi
  # Git Bash on Windows can silently resolve TZ=America/New_York as GMT.
  # Bind the validated TZif file explicitly so both deployment guards use
  # actual Eastern civil time on Windows and Linux.
  TZ=":$tzif_path" date '+%u %H%M'
}

production_backend_deploy_window_preflight() {
  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ]]; then
    return 0
  fi

  local phase="${1:-before deployment}"
  local raw weekday hhmm extra hour minute numeric_hhmm
  if ! raw=$(production_eastern_weekday_hhmm); then
    error "Could not resolve the America/New_York deployment clock; refusing the production backend deployment."
    return 1
  fi
  read -r weekday hhmm extra <<< "$raw"
  hhmm="${hhmm%$'\r'}"
  extra="${extra%$'\r'}"

  if [[ ! "$weekday" =~ ^[1-7]$ || ! "$hhmm" =~ ^[0-2][0-9][0-5][0-9]$ || -n "$extra" ]]; then
    error "The America/New_York deployment clock was malformed or ambiguous; refusing the production backend deployment."
    return 1
  fi
  hour="${hhmm:0:2}"
  minute="${hhmm:2:2}"
  if (( 10#$hour > 23 )); then
    error "The America/New_York deployment clock was malformed or ambiguous; refusing the production backend deployment."
    return 1
  fi

  numeric_hhmm=$((10#$hour * 100 + 10#$minute))
  if (( 10#$weekday <= 5 && numeric_hhmm >= 445 && numeric_hhmm < 1015 )); then
    error "Production backend deploys are blocked weekdays 04:45-10:15 America/New_York so the 05:45 six-task arrival action cannot cross migration or a 200% ECS rollout (${phase})."
    return 1
  fi

  success "Production backend deployment window preflight OK (${phase}; America/New_York weekday=${weekday} time=${hhmm})"
}

classpilot_tile_auth_plan_window_preflight() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" != true &&
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi

  local raw weekday hhmm extra hour minute numeric_hhmm
  if ! raw=$(production_eastern_weekday_hhmm); then
    error "Could not resolve the America/New_York clock for the ClassPilot tile authorization plan gate."
    return 1
  fi
  read -r weekday hhmm extra <<< "$raw"
  hhmm="${hhmm%$'\r'}"
  extra="${extra%$'\r'}"
  if [[ ! "$weekday" =~ ^[1-7]$ || ! "$hhmm" =~ ^[0-2][0-9][0-5][0-9]$ || -n "$extra" ]]; then
    error "The America/New_York clock for the ClassPilot tile authorization plan gate was malformed or ambiguous."
    return 1
  fi
  hour="${hhmm:0:2}"
  minute="${hhmm:2:2}"
  if (( 10#$hour > 23 )); then
    error "The America/New_York clock for the ClassPilot tile authorization plan gate was malformed or ambiguous."
    return 1
  fi
  numeric_hhmm=$((10#$hour * 100 + 10#$minute))
  if (( numeric_hhmm >= 115 && numeric_hhmm < 215 )); then
    error "The ClassPilot tile authorization plan gate cannot start during the 01:15-02:15 America/New_York purge/rollup window."
    return 1
  fi
  success "ClassPilot tile authorization plan gate window preflight OK (America/New_York time=${hhmm})"
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

  production_backend_deploy_window_preflight "before autoscaling hold"

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
  # scheduled actions remain live; the deployment-window preflight prevents the
  # six-task arrival action from crossing migration or service replacement.
  if ! production_backend_capacity_preflight "under the autoscaling hold"; then
    error "Production ECS capacity changed after the initial preflight; refusing the migration and service rollout."
    return 1
  fi
  if [[ -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
        -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ||
        "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
        "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
    error "Production ECS task revisions changed after the immutable rollback identities were captured; refusing the migration and service rollout."
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

rollback_classpilot_tile_auth_deployment() {
  local failed=false
  if [[ -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
        -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
    error "The pre-deployment API/worker revisions are unavailable; automatic rollback cannot be proven."
    failed=true
  else
    warn "Rolling the API and scheduler worker back to their exact pre-deployment revisions..."
    if ! aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$SERVICE" \
      --task-definition "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" \
      --output json \
      --region "$REGION" \
      --no-cli-pager > /dev/null; then
      error "The API rollback request failed."
      failed=true
    fi
    if ! aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$WORKER_SERVICE" \
      --task-definition "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" \
      --output json \
      --region "$REGION" \
      --no-cli-pager > /dev/null; then
      error "The scheduler-worker rollback request failed."
      failed=true
    fi
    if ! aws ecs wait services-stable \
      --cluster "$CLUSTER" \
      --services "$SERVICE" "$WORKER_SERVICE" \
      --region "$REGION"; then
      error "The API/worker rollback did not reach the standard ECS stable state."
      failed=true
    elif ! wait_for_production_backend_strict_stability \
      "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION"; then
      error "The API/worker rollback did not reach exact strict convergence."
      failed=true
    else
      success "API and scheduler worker restored to the exact pre-deployment revisions"
    fi
  fi

  if ! restore_production_scaling_hold; then
    error "Autoscaling restoration failed after the guarded identity rollback."
    failed=true
  fi
  if [[ "$failed" == false ]]; then
    CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=false
    CLASSPILOT_TILE_AUTH_SAFE_TERMINAL_REACHED=true
  fi
  [[ "$failed" == false ]]
}

TEMP_FILES=(
  .taskdef-current.json
  .taskdef-template.json
  .taskdef-new.json
  .taskdef-emergency.json
  .taskdef-emergency-registered.json
  .rls-api-source.json
  .rls-worker-source.json
  .rls-standard-api-registered.json
  .rls-emergency-api-registered.json
  .rls-worker-registered.json
  .ecs-network.json
  .tile-auth-plan-task.json
  .tile-auth-plan-result.json
  .tile-auth-plan-preflight-task.json
  .tile-auth-plan-preflight-result.json
  .tile-auth-plan-rehearsed-api.json
  .tile-auth-plan-rehearsed-worker.json
  .migration-task.json
  .migration-result.json
  .migration-stop.json
  .worker-taskdef-current.json
  .worker-env-source.json
  .worker-taskdef-new.json
  .same-image-network.json
  .same-image-network-candidate.json
  .same-image-api-source.json
  .same-image-api-request.json
  .same-image-api-registration.json
  .same-image-api-registered.json
  .same-image-worker-source.json
  .same-image-worker-request.json
  .same-image-worker-registration.json
  .same-image-worker-registered.json
)

cleanup_temp_files() {
  rm -f "${TEMP_FILES[@]}"
}

deploy_exit_cleanup() {
  local exit_code=$?
  trap - EXIT

  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true &&
        "$CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED" == true &&
        "$CLASSPILOT_TILE_AUTH_SAFE_TERMINAL_REACHED" != true ]]; then
    warn "Guarded ClassPilot deploy exited after a possible service mutation; restoring the exact predeployment API and worker revisions..."
    if ! rollback_classpilot_tile_auth_deployment; then
      error "EXIT recovery could not prove the guarded API/worker rollback."
      exit_code=1
    fi
  fi

  if [[ "$PRODUCTION_SCALING_HOLD_ACTIVE" == true ]]; then
    if [[ -n "$SAME_IMAGE_NETWORKING_STAGE" &&
          "$SAME_IMAGE_SERVICE_MUTATION_STARTED" == true &&
          "$SAME_IMAGE_SAFE_TERMINAL_REACHED" != true ]]; then
      warn "Same-image deploy exited after an ECS service mutation; retaining the autoscaling hold during bounded terminal-state recovery..."
      if ! recover_same_image_mutated_services; then
        emit_same_image_hard_stop_record "service_terminal_state_unresolved"
        cleanup_temp_files
        error "Dynamic autoscaling remains suspended because the same-image service revisions are not in an exact safe terminal state. Manual recovery is required immediately."
        exit 1
      fi
    fi
    warn "Deploy exited while the production autoscaling hold was active; attempting recovery..."
    if ! restore_production_scaling_hold; then
      error "EXIT recovery could not restore production API autoscaling. Manual recovery is required immediately."
      exit_code=1
    fi
  fi

  cleanup_temp_files
  exit "$exit_code"
}

# Validate the active API and worker secret contracts without asking SSM to
# decrypt values. Only the redacted Name/Type/Version/ARN projection is kept in
# memory, and SSM's ten-name request limit is handled in bounded batches.
runtime_securestring_preflight() {
  if [[ "$DEPLOY_BACKEND" != true ]]; then
    return 0
  fi

  local service_name container_name task_definition_ref task_secrets_json parameter_output
  local parameter_sets_json="["
  local first_parameter_set=true
  local services=("$SERVICE" "$WORKER_SERVICE")
  local containers=("api" "scheduler-worker")
  local service_index

  for service_index in 0 1; do
    service_name="${services[$service_index]}"
    container_name="${containers[$service_index]}"

    if [[ "$service_name" == "$WORKER_SERVICE" && "$(ecs_service_status "$service_name")" != "ACTIVE" ]]; then
      if [[ "$ENV" == "production" ]]; then
        error "Production scheduler worker is unavailable during the runtime-secret preflight."
        return 1
      fi
      warn "Scheduler worker is not active; validating only the API runtime-secret contract."
      continue
    fi

    if ! task_definition_ref=$(aws ecs describe-services \
      --cluster "$CLUSTER" \
      --services "$service_name" \
      --query 'services[0].taskDefinition' \
      --output text \
      --region "$REGION" \
      --no-cli-pager); then
      error "Could not read the active ${service_name} task definition for the runtime-secret preflight."
      return 1
    fi
    task_definition_ref="${task_definition_ref%$'\r'}"
    if [[ ! "$task_definition_ref" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]]; then
      error "The active ${service_name} task-definition reference was missing or outside the expected AWS account and region."
      return 1
    fi

    local secrets_query="taskDefinition.containerDefinitions[?name==\`${container_name}\`] | [0].secrets"
    if ! task_secrets_json=$(aws ecs describe-task-definition \
      --task-definition "$task_definition_ref" \
      --query "$secrets_query" \
      --output json \
      --region "$REGION" \
      --no-cli-pager); then
      error "Could not read the redacted ${service_name} task secret references."
      return 1
    fi

    if ! parameter_output=$(TASK_SECRETS_JSON="$task_secrets_json" \
      REGION="$REGION" \
      ACCOUNT_ID="$ACCOUNT_ID" \
      PROJECT="$PROJECT" \
      ENVIRONMENT="$ENV" \
      node "$SCRIPT_DIR/validate-runtime-secret-metadata.mjs" references); then
      error "The active ${service_name} task secret references failed closed validation."
      return 1
    fi
    if [[ "$first_parameter_set" == true ]]; then
      first_parameter_set=false
    else
      parameter_sets_json+=","
    fi
    parameter_sets_json+="$parameter_output"
  done
  parameter_sets_json+="]"

  local expected_parameters_json
  if ! expected_parameters_json=$(PARAMETER_SETS_JSON="$parameter_sets_json" node -e '
    const sets = JSON.parse(process.env.PARAMETER_SETS_JSON || "[]");
    if (!Array.isArray(sets) || sets.some((set) => !Array.isArray(set))) process.exit(1);
    const unique = [...new Set(sets.flat())];
    if (unique.length < 10 || unique.length > 13) process.exit(1);
    process.stdout.write(JSON.stringify(unique));
  '); then
    error "The runtime-secret preflight produced an unexpected parameter-name set."
    return 1
  fi

  local metadata_batches_json="["
  local metadata_json
  local first_batch=true
  local parameter_name
  local parameter_names=()
  while IFS= read -r parameter_name; do
    if [[ -n "$parameter_name" ]]; then
      parameter_names+=("$parameter_name")
    fi
  done < <(EXPECTED_PARAMETER_NAMES_JSON="$expected_parameters_json" node -e '
    for (const name of JSON.parse(process.env.EXPECTED_PARAMETER_NAMES_JSON || "[]")) {
      process.stdout.write(`${name}\n`);
    }
  ')

  local offset
  for ((offset = 0; offset < ${#parameter_names[@]}; offset += 10)); do
    local batch=("${parameter_names[@]:offset:10}")
    # Git Bash otherwise treats leading-slash SSM names as local filesystem
    # paths before invoking the Windows AWS CLI.
    if ! metadata_json=$(MSYS2_ARG_CONV_EXCL="*" aws ssm get-parameters \
      --names "${batch[@]}" \
      --no-with-decryption \
      --query '{Parameters:Parameters[].{Name:Name,Type:Type,Version:Version,ARN:ARN},InvalidParameters:InvalidParameters}' \
      --output json \
      --region "$REGION" \
      --no-cli-pager); then
      error "Could not read redacted SSM SecureString metadata."
      return 1
    fi
    if [[ "$first_batch" == true ]]; then
      first_batch=false
    else
      metadata_batches_json+=","
    fi
    metadata_batches_json+="$metadata_json"
  done
  metadata_batches_json+="]"

  if ! SSM_METADATA_BATCHES_JSON="$metadata_batches_json" \
    EXPECTED_PARAMETER_NAMES_JSON="$expected_parameters_json" \
    REGION="$REGION" \
    ACCOUNT_ID="$ACCOUNT_ID" \
    PROJECT="$PROJECT" \
    ENVIRONMENT="$ENV" \
    node "$SCRIPT_DIR/validate-runtime-secret-metadata.mjs" metadata > /dev/null; then
    error "Runtime SecureString metadata failed closed validation."
    return 1
  fi
}

validate_emergency_activation_mode() {
  if [[ "$ACTIVATE_EMERGENCY" != true ]]; then
    return 0
  fi

  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true || "$DEPLOY_FRONTEND" != false ]]; then
    error "--activate-emergency is allowed only with production --backend so no frontend or staging rollout can share the 2048 MiB cutover."
    return 1
  fi
}

validate_rls_table_enablement_mode() {
  if [[ -z "$ENABLE_RLS_TABLE" ]]; then
    return 0
  fi
  case "$ENABLE_RLS_TABLE" in
    classpilot_session_summary_deliveries|passpilot_grade_students|classpilot_monitoring_events,classpilot_session_reports,classpilot_session_staff,classpilot_session_student_reports,classpilot_student_control_states|authorized_pickups,custody_alerts,dismissal_changes,dismissal_overrides,dismissal_queue,family_group_students,homeroom_teachers) ;;
    *)
      error "--enable-rls-table is not reviewed for: ${ENABLE_RLS_TABLE}"
      return 1
      ;;
  esac
  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ||
        "$DEPLOY_FRONTEND" != false || -n "$SAME_IMAGE_NETWORKING_STAGE" ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ||
        -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
        "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    error "--enable-rls-table is a one-release production --backend migration flag and cannot be combined with frontend, same-image, capacity, observation, or rehearsal modes."
    return 1
  fi
}

validate_classpilot_tile_auth_plan_gate_mode() {
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
          "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ||
          -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
          -n "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" ]]; then
      error "The capacity-acceptance release uses its own strict pre/post plan gates and cannot observe, rehearse, or consume a rehearsal receipt."
      return 1
    fi
    if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" != true ||
          "$ENV" != "production" || "$DEPLOY_BACKEND" != true ||
          "$DEPLOY_FRONTEND" != false || "$ACTIVATE_EMERGENCY" != true ||
          -n "$SAME_IMAGE_NETWORKING_STAGE" || "$SKIP_WAIT" == true ||
          -n "$IMAGE_TAG" ]]; then
      error "The historical --capacity-acceptance-release shape requires production --backend --activate-emergency with strict plan gates and rejects frontend, same-image, --skip-wait, and --tag modes; authorization is enforced separately."
      return 1
    fi
    return 0
  fi

  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
    if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ||
          "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
          -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
          -n "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" ]]; then
      error "The ClassPilot tile authorization observation is standalone and cannot admit, run, or consume a rehearsal or deployment gate."
      return 1
    fi
    if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ||
          "$DEPLOY_FRONTEND" != false || "$ACTIVATE_EMERGENCY" != true ||
          -n "$SAME_IMAGE_NETWORKING_STAGE" || "$SKIP_WAIT" == true ]]; then
      error "--classpilot-tile-auth-plan-observation is allowed only with production --backend --activate-emergency and rejects frontend, same-image, and --skip-wait modes."
      return 1
    fi
    return 0
  fi

  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" != true ]]; then
    if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
          -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
          -n "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" ]]; then
      error "ClassPilot tile authorization rehearsal modes require --classpilot-tile-auth-plan-gate."
      return 1
    fi
    return 0
  fi

  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true ||
        "$DEPLOY_FRONTEND" != false || "$ACTIVATE_EMERGENCY" != true ||
        -n "$SAME_IMAGE_NETWORKING_STAGE" || "$SKIP_WAIT" == true ]]; then
    error "--classpilot-tile-auth-plan-gate is allowed only with production --backend --activate-emergency and rejects frontend, same-image, and --skip-wait modes."
    return 1
  fi

  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true &&
        ( -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
          -n "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" ) ]]; then
    error "A ClassPilot tile authorization plan rehearsal cannot consume another rehearsal receipt."
    return 1
  fi
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" != true &&
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" != true &&
        ( -z "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ||
          ! "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" =~ ^[a-f0-9]{64}$ ) ]]; then
    error "A guarded ClassPilot tile authorization plan deployment requires --reuse-classpilot-tile-auth-plan-rehearsal and its out-of-band --expected-classpilot-tile-auth-plan-rehearsal-sha256."
    return 1
  fi
  if [[ -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" &&
        ! "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" =~ ^([A-Za-z]:[\\/]|/) ]]; then
    error "The ClassPilot tile authorization plan rehearsal receipt path must be absolute."
    return 1
  fi
}

read_capacity_acceptance_authorization_state() {
  node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const document = JSON.parse(fs.readFileSync(path, "utf8"));
    const keys = Object.keys(document).sort();
    const expectedKeys = ["authorizedCampaign", "schemaVersion", "state"];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
        document.schemaVersion !== "capacity-acceptance-authorization-v1" ||
        typeof document.state !== "string" ||
        document.authorizedCampaign !== null) {
      process.exit(1);
    }
    process.stdout.write(document.state);
  ' "$CAPACITY_ACCEPTANCE_AUTHORIZATION_PATH"
}

validate_capacity_acceptance_authorization_mode() {
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" != true &&
        -z "$CAPACITY_ACCEPTANCE_FRONTEND_SHA" ]]; then
    return 0
  fi

  local authorization_state
  if ! authorization_state=$(read_capacity_acceptance_authorization_state 2>/dev/null); then
    error "Capacity-acceptance authorization is missing or invalid; production capacity deployment is blocked."
    return 1
  fi
  if [[ "$authorization_state" == "paused" ]]; then
    error "Capacity acceptance is paused; --capacity-acceptance-release and --capacity-acceptance-frontend-sha are historical-only until a separately reviewed authorization is merged."
    return 1
  fi

  error "Capacity-acceptance authorization state '$authorization_state' is unsupported; production capacity deployment is blocked."
  return 1
}

classpilot_tile_auth_plan_identity_binding() {
  local sanitized_report="$1"
  SANITIZED_TILE_AUTH_PLAN_REPORT="$sanitized_report" node <<'NODE'
const crypto = require("crypto");
const report = JSON.parse(process.env.SANITIZED_TILE_AUTH_PLAN_REPORT || "null");
const identity = report?.historyFallbackSqlIdentity;
const exactKeys = [
  "compiledSqlSha256",
  "engineVersion",
  "parameterTypeSignatureSha256",
  "queryIdentifierSha256",
  "schemaIdentitySha256",
  "trackIoTiming",
  "version",
];
if (!identity || identity.trackIoTiming !== true ||
    JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(exactKeys)) {
  process.exit(1);
}
const canonical = JSON.stringify(Object.fromEntries(exactKeys.map((key) => [key, identity[key]])));
const binding = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
process.stdout.write(`${binding}\t${identity.queryIdentifierSha256}`);
NODE
}

production_database_identity() {
  local posture_json
  if ! posture_json=$(aws rds describe-db-instances \
    --db-instance-identifier "${NAME}-db" \
    --query 'DBInstances[0].{identifier:DBInstanceIdentifier,resourceId:DbiResourceId,engine:Engine,engineVersion:EngineVersion,instanceClass:DBInstanceClass,status:DBInstanceStatus,pending:PendingModifiedValues,parameterGroups:DBParameterGroups}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager); then
    return 1
  fi
  PRODUCTION_DATABASE_POSTURE_JSON="$posture_json" EXPECTED_DATABASE_IDENTIFIER="${NAME}-db" node <<'NODE'
const posture = JSON.parse(process.env.PRODUCTION_DATABASE_POSTURE_JSON || "null");
const parameters = Array.isArray(posture?.parameterGroups) ? posture.parameterGroups : [];
if (!posture || posture.identifier !== process.env.EXPECTED_DATABASE_IDENTIFIER ||
    !/^db-[A-Z0-9]{8,64}$/.test(posture.resourceId || "") ||
    posture.engine !== "postgres" ||
    typeof posture.engineVersion !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(posture.engineVersion) ||
    posture.instanceClass !== "db.t4g.medium" || posture.status !== "available" ||
    !posture.pending || Object.keys(posture.pending).length !== 0 ||
    parameters.length === 0 || parameters.some((entry) => entry?.ParameterApplyStatus !== "in-sync")) {
  process.exit(1);
}
process.stdout.write(`${posture.resourceId}\t${posture.engineVersion}`);
NODE
}

write_classpilot_history_fallback_identity_receipt() {
  local events_json="$1"
  local expected_query_identifier_sha256="$2"
  local database_binding database_resource_id engine_version extra
  if [[ -z "${LOCALAPPDATA:-}" ]]; then
    error "LOCALAPPDATA is required for the ACL-restricted history fallback identity receipt."
    return 1
  fi
  if ! database_binding=$(production_database_identity); then
    error "Production RDS identity/posture is not exactly available db.t4g.medium with in-sync parameters."
    return 1
  fi
  IFS=$'\t' read -r database_resource_id engine_version extra <<< "$database_binding"
  if [[ -z "$database_resource_id" || -z "$engine_version" || -n "$extra" ]]; then
    error "Production RDS identity was malformed or ambiguous."
    return 1
  fi

  local api_task_definition_arn="$API_ROLLOUT_TASK_DEF"
  local worker_task_definition_arn="arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${WORKER_SERVICE}:${WORKER_NEW_REV}"
  local output_directory="${LOCALAPPDATA}/SchoolPilot/load-gates/pi-identities/${LOCAL_SHA}"
  local receipt_summary receipt_binding receipt_path receipt_path_sha receipt_sha receipt_query_sha receipt_identity_sha
  if ! receipt_summary=$(printf '%s' "$events_json" | node \
    "$SCRIPT_DIR/write-classpilot-history-fallback-identity-receipt.mjs" \
    --output "$output_directory" \
    --application-sha "$LOCAL_SHA" \
    --image-digest "$DIGEST" \
    --api-task-definition-arn "$api_task_definition_arn" \
    --worker-task-definition-arn "$worker_task_definition_arn" \
    --database-resource-id "$database_resource_id" \
    --engine-version "$engine_version" \
    --expected-query-identifier-sha256 "$expected_query_identifier_sha256" 2>/dev/null); then
    error "The ACL-restricted history fallback identity receipt could not be sealed."
    return 1
  fi
  if ! receipt_binding=$(HISTORY_FALLBACK_RECEIPT_SUMMARY="$receipt_summary" node <<'NODE'
const summary = JSON.parse(process.env.HISTORY_FALLBACK_RECEIPT_SUMMARY || "null");
const hash = /^[a-f0-9]{64}$/;
if (summary?.schemaVersion !== 1 || summary?.identityVersion !== "history-fallback-queryid-v1" ||
    typeof summary.path !== "string" || summary.path.length === 0 ||
    !hash.test(summary.sha256 || "") || !hash.test(summary.queryIdentifierSha256 || "") ||
    !hash.test(summary.compiledSqlSha256 || "") || !hash.test(summary.parameterTypeSignatureSha256 || "") ||
    !hash.test(summary.schemaIdentitySha256 || "") || summary.trackIoTiming !== true) process.exit(1);
const identity = {
  compiledSqlSha256: summary.compiledSqlSha256,
  engineVersion: summary.engineVersion,
  parameterTypeSignatureSha256: summary.parameterTypeSignatureSha256,
  queryIdentifierSha256: summary.queryIdentifierSha256,
  schemaIdentitySha256: summary.schemaIdentitySha256,
  trackIoTiming: true,
  version: summary.identityVersion,
};
const identitySha = require("crypto").createHash("sha256")
  .update(JSON.stringify(identity), "utf8").digest("hex");
const pathSha = require("crypto").createHash("sha256")
  .update(summary.path, "utf8").digest("hex");
process.stdout.write(`${summary.path}\t${pathSha}\t${summary.sha256}\t${summary.queryIdentifierSha256}\t${identitySha}`);
NODE
  ); then
    error "The sealed history fallback identity receipt summary was malformed."
    return 1
  fi
  IFS=$'\t' read -r receipt_path receipt_path_sha receipt_sha receipt_query_sha receipt_identity_sha extra <<< "$receipt_binding"
  if [[ -z "$receipt_path" || ! "$receipt_path_sha" =~ ^[a-f0-9]{64}$ ||
        -z "$receipt_sha" || -n "$extra" ||
        "$receipt_query_sha" != "$expected_query_identifier_sha256" ||
        "$receipt_identity_sha" != "$TILE_AUTH_PLAN_PRE_IDENTITY_SHA256" ]]; then
    error "The sealed history fallback identity receipt does not match the pre-deployment identity."
    return 1
  fi
  TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH_SHA256="$receipt_path_sha"
  TILE_AUTH_PLAN_IDENTITY_RECEIPT_SHA256="$receipt_sha"
  success "History fallback query identity receipt sealed (receiptSha256=${receipt_sha}, queryIdentifierSha256=${receipt_query_sha})"
}

read_classpilot_tile_auth_plan_terminal_exit_code() {
  local result_path="$1"
  local expected_task_arn="$2"
  local expected_task_definition="$3"
  TILE_AUTH_PLAN_RESULT_PATH="$result_path" \
    EXPECTED_TASK_ARN="$expected_task_arn" \
    EXPECTED_TASK_DEFINITION="$expected_task_definition" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const fs = require("fs");
const value = JSON.parse(
  fs.readFileSync(process.env.TILE_AUTH_PLAN_RESULT_PATH, "utf8")
);
const failures = Array.isArray(value?.failures) ? value.failures : [];
const tasks = Array.isArray(value?.tasks) ? value.tasks : [];
const task = tasks[0];
const taskPrefix =
  `arn:aws:ecs:${process.env.EXPECTED_REGION}:` +
  `${process.env.EXPECTED_ACCOUNT_ID}:task/`;
const containers = Array.isArray(task?.containers) ? task.containers : [];
const api = containers.filter((container) => container?.name === "api");
const exitCode = api[0]?.exitCode;
if (
  failures.length !== 0 ||
  tasks.length !== 1 ||
  task?.taskArn !== process.env.EXPECTED_TASK_ARN ||
  !task.taskArn.startsWith(taskPrefix) ||
  task?.taskDefinitionArn !== process.env.EXPECTED_TASK_DEFINITION ||
  task?.lastStatus !== "STOPPED" ||
  api.length !== 1 ||
  api[0]?.lastStatus !== "STOPPED" ||
  !Number.isInteger(exitCode) ||
  exitCode < 0 ||
  exitCode > 255
) {
  process.exit(1);
}
process.stdout.write(String(exitCode));
NODE
}

run_classpilot_tile_auth_plan_gate() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" != true ]]; then
    return 0
  fi

  local phase="${1:-predeploy}"
  if [[ "$phase" == "predeploy" ]]; then
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=false
  fi
  local failure_suffix="No migration or service rollout was attempted."
  if [[ "$phase" != "predeploy" && "$phase" != "postdeploy" ]]; then
    error "The ClassPilot tile authorization plan gate phase is invalid."
    return 1
  fi
  if [[ "$phase" == "postdeploy" ]]; then
    failure_suffix="The new service revisions must be rolled back."
  fi

  if ! production_backend_deploy_window_preflight "before ClassPilot plan-gate ${phase} task"; then
    return 1
  fi
  if ! classpilot_tile_auth_plan_window_preflight; then
    return 1
  fi

  local expected_task_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api-emergency:[1-9][0-9]*$"
  if [[ ! "$API_ROLLOUT_TASK_DEF" =~ $expected_task_pattern ]]; then
    error "The ClassPilot tile authorization plan gate requires the exact freshly registered emergency task-definition ARN."
    return 1
  fi

  local started_by="sp-tile-${phase}-${IMAGE_TAG}"
  if [[ ! "$started_by" =~ ^[A-Za-z0-9_-]{1,36}$ ]]; then
    error "The release image tag cannot be bound safely to the ClassPilot tile authorization plan task."
    return 1
  fi

  info "Running the fixed ClassPilot tile authorization plan gate (${phase}) against ${API_ROLLOUT_TASK_DEF}..."
  if ! aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --network-configuration "$NETWORK_CONFIG" \
    --count 1 \
    --started-by "$started_by" \
    --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/cli/checkClasspilotTileAuthorizationPlans.js","--execute"],"environment":[{"name":"RUN_MIGRATIONS_ON_STARTUP","value":"false"},{"name":"RUN_MIGRATIONS_ONLY","value":"false"},{"name":"SCHEDULER_ENABLED","value":"false"}]}]}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .tile-auth-plan-task.json; then
    error "The ClassPilot tile authorization plan task could not be started. ${failure_suffix}"
    return 1
  fi

  local task_arn
  if ! task_arn=$(TILE_AUTH_PLAN_TASK_PATH=".tile-auth-plan-task.json" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.TILE_AUTH_PLAN_TASK_PATH, "utf8"));
const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
const failures = Array.isArray(response?.failures) ? response.failures : [];
const task = tasks[0];
const prefix = `arn:aws:ecs:${process.env.EXPECTED_REGION}:${process.env.EXPECTED_ACCOUNT_ID}:task/`;
if (failures.length !== 0 || tasks.length !== 1 ||
    task?.taskDefinitionArn !== process.env.EXPECTED_TASK_DEFINITION ||
    typeof task?.taskArn !== "string" || !task.taskArn.startsWith(prefix)) process.exit(1);
process.stdout.write(task.taskArn);
NODE
  ); then
    error "ECS did not return exactly one ClassPilot tile authorization plan task bound to the expected revision. ${failure_suffix}"
    return 1
  fi

  set +e
  wait_for_classpilot_tile_auth_plan_task_stopped "$task_arn"
  local wait_result=$?
  set -e
  if [[ "$wait_result" -eq 124 ]]; then
    if [[ "$phase" == "predeploy" ]]; then
      TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    fi
    error "The ClassPilot tile authorization plan task exceeded its 900-second controller deadline and was stopped. ${failure_suffix}"
    return 1
  elif [[ "$wait_result" -eq 125 ]]; then
    error "The ClassPilot tile authorization plan task did not report STOPPED within the bounded stop-observation window. ${failure_suffix}"
    return 1
  elif [[ "$wait_result" -ne 0 ]]; then
    error "ClassPilot tile authorization plan task observation failed. ${failure_suffix}"
    return 1
  fi

  if ! aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$task_arn" \
    --query '{failures:failures,tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,logStreamName:logStreamName}}}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .tile-auth-plan-result.json; then
    error "The terminal ClassPilot tile authorization plan task could not be described. ${failure_suffix}"
    return 1
  fi

  local task_exit_code
  if ! task_exit_code=$(read_classpilot_tile_auth_plan_terminal_exit_code \
    ".tile-auth-plan-result.json" \
    "$task_arn" \
    "$API_ROLLOUT_TASK_DEF"); then
    error "The terminal ClassPilot tile authorization plan task identity or exit code was invalid. ${failure_suffix}"
    return 1
  fi
  if [[ "$phase" == "predeploy" && "$task_exit_code" != "0" ]]; then
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
  fi

  local log_configuration_json log_binding log_group log_region log_prefix log_stream bound_task_exit_code extra
  if ! log_configuration_json=$(aws ecs describe-task-definition \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --query 'taskDefinition.containerDefinitions[?name==`api`] | [0].logConfiguration' \
    --output json \
    --region "$REGION" \
    --no-cli-pager); then
    error "The ClassPilot tile authorization plan task log binding could not be resolved. ${failure_suffix}"
    return 1
  fi
  if ! log_binding=$(TILE_AUTH_PLAN_RESULT_PATH=".tile-auth-plan-result.json" \
    TILE_AUTH_PLAN_LOG_CONFIGURATION_JSON="$log_configuration_json" \
    EXPECTED_TASK_ARN="$task_arn" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" \
    node "$SCRIPT_DIR/resolve-classpilot-tile-auth-plan-log-binding.mjs" 2>/dev/null
  ); then
    error "The ClassPilot tile authorization plan task or its exact awslogs binding is invalid. ${failure_suffix}"
    return 1
  fi
  IFS=$'\t' read -r log_group log_region log_prefix log_stream bound_task_exit_code extra <<< "$log_binding"
  if [[ -z "$log_group" || "$log_region" != "$REGION" || -z "$log_prefix" || -n "$extra" ||
        -z "$log_stream" || "$log_stream" != "${log_prefix}/api/"* ||
        "$bound_task_exit_code" != "$task_exit_code" ]]; then
    error "The ClassPilot tile authorization plan log stream does not match the exact API task definition. ${failure_suffix}"
    return 1
  fi

  local log_deadline=$((SECONDS + TILE_AUTH_PLAN_LOG_WAIT_SECONDS))
  local events_json sanitized_report="" sanitized_failure_code=""
  while (( SECONDS < log_deadline )); do
    events_json=""
    if events_json=$(MSYS_NO_PATHCONV=1 node \
      "$SCRIPT_DIR/read-classpilot-tile-auth-plan-log-events.mjs" \
      --log-group-name "$log_group" \
      --log-stream-name "$log_stream" \
      --region "$REGION" 2>/dev/null); then
      if [[ "$task_exit_code" == "0" ]]; then
        if sanitized_report=$(printf '%s' "$events_json" | \
          node "$SCRIPT_DIR/validate-classpilot-tile-auth-plan-evidence.mjs" 2>/dev/null); then
          break
        fi
        sanitized_report=""
      elif sanitized_failure_code=$(printf '%s' "$events_json" | \
        node "$SCRIPT_DIR/extract-classpilot-tile-auth-plan-failure.mjs" 2>/dev/null); then
        break
      else
        sanitized_failure_code=""
      fi
    fi
    sleep "$TILE_AUTH_PLAN_LOG_POLL_SECONDS"
  done
  if [[ "$task_exit_code" != "0" ]]; then
    if [[ "$phase" == "predeploy" ]]; then
      TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    fi
    if [[ -z "$sanitized_failure_code" ]]; then
      error "The failed ClassPilot tile authorization plan task did not publish one allowlisted sanitized failure within the bounded CloudWatch window. ${failure_suffix}"
    else
      error "The ClassPilot tile authorization plan task failed (failureCode=${sanitized_failure_code}). ${failure_suffix}"
    fi
    return 1
  fi
  if [[ -z "$sanitized_report" ]]; then
    error "No valid sanitized ClassPilot tile authorization plan evidence appeared within the bounded CloudWatch window. ${failure_suffix}"
    return 1
  fi

  local identity_binding identity_sha256 query_identifier_sha256 extra
  if ! identity_binding=$(classpilot_tile_auth_plan_identity_binding "$sanitized_report"); then
    if [[ "$phase" == "predeploy" ]]; then
      TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    fi
    error "The sanitized ClassPilot history fallback SQL identity could not be canonicalized. ${failure_suffix}"
    return 1
  fi
  IFS=$'\t' read -r identity_sha256 query_identifier_sha256 extra <<< "$identity_binding"
  if [[ ! "$identity_sha256" =~ ^[a-f0-9]{64}$ ||
        ! "$query_identifier_sha256" =~ ^[a-f0-9]{64}$ || -n "$extra" ]]; then
    if [[ "$phase" == "predeploy" ]]; then
      TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    fi
    error "The sanitized ClassPilot history fallback SQL identity was malformed. ${failure_suffix}"
    return 1
  fi

  if [[ "$phase" == "predeploy" ]]; then
    if [[ -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" &&
          ( "$identity_sha256" != "$TILE_AUTH_PLAN_REHEARSAL_IDENTITY_SHA256" ||
            "$query_identifier_sha256" != "$TILE_AUTH_PLAN_REHEARSAL_QUERY_IDENTIFIER_SHA256" ) ]]; then
      TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
      error "The pre-deployment history fallback SQL identity differs from the consumed candidate rehearsal. ${failure_suffix}"
      return 1
    fi
    TILE_AUTH_PLAN_PRE_IDENTITY_SHA256="$identity_sha256"
    TILE_AUTH_PLAN_PRE_QUERY_IDENTIFIER_SHA256="$query_identifier_sha256"
    TILE_AUTH_PLAN_PREDEPLOY_EVENTS_JSON="$events_json"
    TILE_AUTH_PLAN_PREDEPLOY_REPORT_JSON="$sanitized_report"
  else
    if [[ -z "$TILE_AUTH_PLAN_PRE_IDENTITY_SHA256" ||
          -z "$TILE_AUTH_PLAN_PRE_QUERY_IDENTIFIER_SHA256" ||
          "$identity_sha256" != "$TILE_AUTH_PLAN_PRE_IDENTITY_SHA256" ||
          "$query_identifier_sha256" != "$TILE_AUTH_PLAN_PRE_QUERY_IDENTIFIER_SHA256" ]]; then
      error "The post-deployment history fallback SQL identity differs from the pre-deployment plan gate. ${failure_suffix}"
      return 1
    fi
    if ! write_classpilot_history_fallback_identity_receipt \
      "$events_json" "$query_identifier_sha256"; then
      error "The post-deployment history fallback SQL identity could not be bound to an immutable private receipt. ${failure_suffix}"
      return 1
    fi
  fi

  success "ClassPilot tile authorization plan gate passed (phase=${phase}, identitySha256=${identity_sha256}, queryIdentifierSha256=${query_identifier_sha256}, logGroup=${log_group}, logStream=${log_stream})"
  printf '%s\n' "$sanitized_report"
}

set_classpilot_tile_auth_observation_collection_failure() {
  local failure_code="$1"
  TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON=$(OBSERVATION_FAILURE_CODE="$failure_code" node <<'NODE'
const allowed = new Set([
  "terminal_task_unavailable",
  "terminal_task_timeout",
  "terminal_task_description_unavailable",
  "log_binding_unavailable",
  "collector_start_unavailable",
]);
const failureCode = process.env.OBSERVATION_FAILURE_CODE;
if (!allowed.has(failureCode)) process.exit(1);
process.stdout.write(JSON.stringify({
  collection: {
    status: "failed",
    attemptCount: 0,
    completedAtUtc: new Date().toISOString(),
    failureCode,
    canonicalEventSha256: null,
    logStreamSha256: null,
    rawErrorPersisted: false,
  },
  eventsDocument: null,
}));
NODE
  )
}

run_classpilot_tile_auth_plan_observation_task() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi

  local expected_task_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api-emergency:[1-9][0-9]*$"
  if [[ ! "$API_ROLLOUT_TASK_DEF" =~ $expected_task_pattern ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_ID" =~ ^[a-z0-9][a-z0-9-]{7,127}$ ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH" ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    return 0
  fi

  local started_by="sp-tile-observe-${LOCAL_SHA:0:12}"
  info "Running the read-only ClassPilot tile authorization base observation against ${API_ROLLOUT_TASK_DEF}..."
  if ! aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --network-configuration "$NETWORK_CONFIG" \
    --count 1 \
    --started-by "$started_by" \
    --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/cli/checkClasspilotTileAuthorizationPlans.js","--preflight-base","--observation-selection"],"environment":[{"name":"RUN_MIGRATIONS_ON_STARTUP","value":"false"},{"name":"RUN_MIGRATIONS_ONLY","value":"false"},{"name":"SCHEDULER_ENABLED","value":"false"}]}]}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > "$TILE_AUTH_PLAN_OBSERVATION_TASK_PATH"; then
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    return 0
  fi

  local task_arn
  if ! task_arn=$(TILE_AUTH_PLAN_TASK_PATH="$TILE_AUTH_PLAN_OBSERVATION_TASK_PATH" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.TILE_AUTH_PLAN_TASK_PATH, "utf8"));
const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
const failures = Array.isArray(response?.failures) ? response.failures : [];
const task = tasks[0];
const taskPattern = new RegExp(
  `^arn:aws:ecs:${process.env.EXPECTED_REGION}:${process.env.EXPECTED_ACCOUNT_ID}:task/(?:[^/]+/)?[a-f0-9]{32}$`
);
if (failures.length !== 0 || tasks.length !== 1 ||
    task?.taskDefinitionArn !== process.env.EXPECTED_TASK_DEFINITION ||
    typeof task?.taskArn !== "string" ||
    !taskPattern.test(task.taskArn)) process.exit(1);
process.stdout.write(task.taskArn);
NODE
  ); then
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    return 0
  fi
  TILE_AUTH_PLAN_OBSERVATION_TASK_ARN="$task_arn"
  TILE_AUTH_PLAN_OBSERVATION_TASK_STATE="exit_unavailable"

  local wait_result
  if wait_for_classpilot_tile_auth_plan_task_stopped "$task_arn"; then
    wait_result=0
  else
    wait_result=$?
  fi

  local terminal_failure_code=""
  if [[ "$wait_result" -eq 124 || "$wait_result" -eq 125 ]]; then
    terminal_failure_code="terminal_task_timeout"
  elif [[ "$wait_result" -ne 0 ]]; then
    terminal_failure_code="terminal_task_description_unavailable"
  fi

  local terminal_description_available=false
  if AWS_MAX_ATTEMPTS=1 aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$task_arn" \
    --query '{failures:failures,tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,logStreamName:logStreamName}}}' \
    --output json \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30 \
    --region "$REGION" \
    --no-cli-pager > "$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH"; then
    terminal_description_available=true
  fi

  local task_exit_code
  if [[ "$terminal_description_available" == true ]] &&
     task_exit_code=$(OBSERVATION_RESULT_PATH="$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH" \
    EXPECTED_TASK_ARN="$task_arn" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" node <<'NODE'
const fs = require("fs");
const result = JSON.parse(
  fs.readFileSync(process.env.OBSERVATION_RESULT_PATH, "utf8")
);
const tasks = Array.isArray(result?.tasks) ? result.tasks : [];
const failures = Array.isArray(result?.failures) ? result.failures : [];
const task = tasks[0];
const containers = Array.isArray(task?.containers)
  ? task.containers.filter((container) => container?.name === "api")
  : [];
const exitCode = containers[0]?.exitCode;
if (failures.length !== 0 || tasks.length !== 1 ||
    task?.taskArn !== process.env.EXPECTED_TASK_ARN ||
    task?.taskDefinitionArn !== process.env.EXPECTED_TASK_DEFINITION ||
    task?.lastStatus !== "STOPPED" || containers.length !== 1 ||
    containers[0]?.lastStatus !== "STOPPED" ||
    !Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
  process.exit(1);
}
process.stdout.write(String(exitCode));
NODE
  ); then
    TILE_AUTH_PLAN_OBSERVATION_TASK_EXIT_CODE="$task_exit_code"
    TILE_AUTH_PLAN_OBSERVATION_TASK_STATE="exited"
  elif [[ -z "$terminal_failure_code" ]]; then
    terminal_failure_code="terminal_task_description_unavailable"
  fi

  if [[ -n "$terminal_failure_code" ]]; then
    set_classpilot_tile_auth_observation_collection_failure \
      "$terminal_failure_code"
    return 0
  fi

  if ! AWS_MAX_ATTEMPTS=1 aws ecs describe-task-definition \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --query 'taskDefinition.containerDefinitions[?name==`api`] | [0].logConfiguration' \
    --output json \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30 \
    --region "$REGION" \
    --no-cli-pager > "$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH"; then
    set_classpilot_tile_auth_observation_collection_failure \
      "log_binding_unavailable"
    return 0
  fi
  if ! TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON=$(MSYS_NO_PATHCONV=1 node \
    "$SCRIPT_DIR/collect-classpilot-tile-auth-plan-observation-evidence.mjs" \
    --task-result-file "$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH" \
    --log-configuration-file "$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH" \
    --expected-task-arn "$task_arn" \
    --expected-task-definition-arn "$API_ROLLOUT_TASK_DEF" \
    --expected-region "$REGION" \
    --expected-account-id "$ACCOUNT_ID" \
    --deadline-ms "$TILE_AUTH_PLAN_OBSERVATION_EVIDENCE_DEADLINE_MS" \
    2>/dev/null); then
    set_classpilot_tile_auth_observation_collection_failure \
      "collector_start_unavailable"
  fi
  return 0
}

run_classpilot_tile_auth_plan_base_preflight() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" != true ]]; then
    return 0
  fi
  TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=false

  if ! production_backend_deploy_window_preflight "before ClassPilot plan-gate base-preflight task"; then
    return 1
  fi
  if ! classpilot_tile_auth_plan_window_preflight; then
    return 1
  fi

  local expected_task_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api-emergency:[1-9][0-9]*$"
  if [[ ! "$API_ROLLOUT_TASK_DEF" =~ $expected_task_pattern ]]; then
    error "The ClassPilot tile authorization base preflight requires the exact freshly registered emergency task-definition ARN."
    return 1
  fi

  local started_by="sp-tile-base-${IMAGE_TAG}"
  if [[ ! "$started_by" =~ ^[A-Za-z0-9_-]{1,36}$ ]]; then
    error "The release image tag cannot be bound safely to the ClassPilot tile authorization base preflight."
    return 1
  fi

  info "Running the read-only ClassPilot tile authorization base preflight against ${API_ROLLOUT_TASK_DEF}..."
  if ! aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --network-configuration "$NETWORK_CONFIG" \
    --count 1 \
    --started-by "$started_by" \
    --overrides '{"containerOverrides":[{"name":"api","command":["node","dist/cli/checkClasspilotTileAuthorizationPlans.js","--preflight-base"],"environment":[{"name":"RUN_MIGRATIONS_ON_STARTUP","value":"false"},{"name":"RUN_MIGRATIONS_ONLY","value":"false"},{"name":"SCHEDULER_ENABLED","value":"false"}]}]}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .tile-auth-plan-preflight-task.json; then
    error "The ClassPilot tile authorization base preflight task could not be started. No migration or service rollout was attempted."
    return 1
  fi

  local task_arn
  if ! task_arn=$(TILE_AUTH_PLAN_TASK_PATH=".tile-auth-plan-preflight-task.json" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.TILE_AUTH_PLAN_TASK_PATH, "utf8"));
const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
const failures = Array.isArray(response?.failures) ? response.failures : [];
const task = tasks[0];
const prefix = `arn:aws:ecs:${process.env.EXPECTED_REGION}:${process.env.EXPECTED_ACCOUNT_ID}:task/`;
if (failures.length !== 0 || tasks.length !== 1 ||
    task?.taskDefinitionArn !== process.env.EXPECTED_TASK_DEFINITION ||
    typeof task?.taskArn !== "string" || !task.taskArn.startsWith(prefix)) process.exit(1);
process.stdout.write(task.taskArn);
NODE
  ); then
    error "ECS did not return exactly one base-preflight task bound to the expected candidate revision."
    return 1
  fi
  set +e
  wait_for_classpilot_tile_auth_plan_task_stopped "$task_arn"
  local wait_result=$?
  set -e
  if [[ "$wait_result" -eq 124 ]]; then
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    error "The ClassPilot tile authorization base preflight exceeded its 900-second controller deadline and was stopped."
    return 1
  elif [[ "$wait_result" -eq 125 ]]; then
    error "The ClassPilot tile authorization base preflight did not report STOPPED within the bounded stop-observation window."
    return 1
  elif [[ "$wait_result" -ne 0 ]]; then
    error "ClassPilot tile authorization base preflight observation failed."
    return 1
  fi

  if ! aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$task_arn" \
    --query '{failures:failures,tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,containers:containers[].{name:name,lastStatus:lastStatus,exitCode:exitCode,logStreamName:logStreamName}}}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .tile-auth-plan-preflight-result.json; then
    error "The terminal ClassPilot tile authorization base preflight task could not be described."
    return 1
  fi

  local task_exit_code
  if ! task_exit_code=$(read_classpilot_tile_auth_plan_terminal_exit_code \
    ".tile-auth-plan-preflight-result.json" \
    "$task_arn" \
    "$API_ROLLOUT_TASK_DEF"); then
    error "The terminal ClassPilot tile authorization base preflight task identity or exit code was invalid."
    return 1
  fi
  if [[ "$task_exit_code" != "0" ]]; then
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
  fi

  local log_configuration_json log_binding log_group log_region log_prefix log_stream bound_task_exit_code extra
  if ! log_configuration_json=$(aws ecs describe-task-definition \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --query 'taskDefinition.containerDefinitions[?name==`api`] | [0].logConfiguration' \
    --output json \
    --region "$REGION" \
    --no-cli-pager); then
    error "The ClassPilot tile authorization base preflight log binding could not be resolved."
    return 1
  fi
  if ! log_binding=$(TILE_AUTH_PLAN_RESULT_PATH=".tile-auth-plan-preflight-result.json" \
    TILE_AUTH_PLAN_LOG_CONFIGURATION_JSON="$log_configuration_json" \
    EXPECTED_TASK_ARN="$task_arn" \
    EXPECTED_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" \
    node "$SCRIPT_DIR/resolve-classpilot-tile-auth-plan-log-binding.mjs" 2>/dev/null
  ); then
    error "The ClassPilot tile authorization base preflight task or its exact awslogs binding is invalid."
    return 1
  fi
  IFS=$'\t' read -r log_group log_region log_prefix log_stream bound_task_exit_code extra <<< "$log_binding"
  if [[ -z "$log_group" || "$log_region" != "$REGION" || -z "$log_prefix" ||
        -z "$log_stream" || "$log_stream" != "${log_prefix}/api/"* ||
        "$bound_task_exit_code" != "$task_exit_code" ||
        -n "$extra" ]]; then
    error "The ClassPilot tile authorization base preflight log stream does not match the exact candidate task definition."
    return 1
  fi
  local log_deadline=$((SECONDS + TILE_AUTH_PLAN_LOG_WAIT_SECONDS))
  local events_json="" sanitized_preflight="" sanitized_failure_code=""
  while (( SECONDS < log_deadline )); do
    if events_json=$(MSYS_NO_PATHCONV=1 node \
      "$SCRIPT_DIR/read-classpilot-tile-auth-plan-log-events.mjs" \
      --log-group-name "$log_group" \
      --log-stream-name "$log_stream" \
      --region "$REGION" 2>/dev/null); then
      if [[ "$task_exit_code" == "0" ]]; then
        if sanitized_preflight=$(printf '%s' "$events_json" | \
          node "$SCRIPT_DIR/validate-classpilot-tile-auth-plan-preflight-evidence.mjs" 2>/dev/null); then
          break
        fi
        sanitized_preflight=""
      elif sanitized_failure_code=$(printf '%s' "$events_json" | \
        node "$SCRIPT_DIR/extract-classpilot-tile-auth-plan-failure.mjs" 2>/dev/null); then
        break
      else
        sanitized_failure_code=""
      fi
    fi
    sleep "$TILE_AUTH_PLAN_LOG_POLL_SECONDS"
  done

  if [[ "$task_exit_code" != "0" ]]; then
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=true
    if [[ -z "$sanitized_failure_code" ]]; then
      error "The failed ClassPilot tile authorization base preflight did not publish one allowlisted sanitized failure."
    else
      error "The ClassPilot tile authorization base preflight failed (failureCode=${sanitized_failure_code})."
    fi
    return 1
  fi
  if [[ -z "$sanitized_preflight" ]]; then
    error "No valid sanitized ClassPilot tile authorization base-preflight evidence appeared within the bounded CloudWatch window."
    return 1
  fi

  TILE_AUTH_PLAN_PREFLIGHT_EVENTS_JSON="$events_json"
  TILE_AUTH_PLAN_PREFLIGHT_EVIDENCE_JSON="$sanitized_preflight"
  success "ClassPilot tile authorization base preflight passed (logGroup=${log_group}, logStream=${log_stream})"
  printf '%s\n' "$sanitized_preflight"
}

resolve_classpilot_tile_auth_candidate_network() {
  info "Resolving the exact ECS network configuration for candidate gate tasks..."
  if ! aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" \
    --query 'services[0].networkConfiguration.awsvpcConfiguration' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .ecs-network.json; then
    error "Could not read the active API network configuration."
    return 1
  fi

  local binding network_config network_sha extra
  if ! binding=$(node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(".ecs-network.json", "utf8"));
    const subnets = [...new Set(Array.isArray(cfg?.subnets) ? cfg.subnets : [])].sort();
    const securityGroups = [...new Set(
      Array.isArray(cfg?.securityGroups) ? cfg.securityGroups : []
    )].sort();
    const assignPublicIp = cfg?.assignPublicIp || "DISABLED";
    if (subnets.length === 0 || securityGroups.length === 0 ||
        !["ENABLED", "DISABLED"].includes(assignPublicIp) ||
        subnets.some((value) => !/^subnet-[a-f0-9]+$/.test(value)) ||
        securityGroups.some((value) => !/^sg-[a-f0-9]+$/.test(value))) {
      process.exit(1);
    }
    const canonical = JSON.stringify({assignPublicIp,securityGroups,subnets});
    const hash = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    const rendered =
      `awsvpcConfiguration={subnets=[${subnets.join(",")}],` +
      `securityGroups=[${securityGroups.join(",")}],assignPublicIp=${assignPublicIp}}`;
    process.stdout.write(`${rendered}\t${hash}`);
  '); then
    error "The active API network configuration is malformed or ambiguous."
    return 1
  fi
  IFS=$'\t' read -r network_config network_sha extra <<< "$binding"
  if [[ -z "$network_config" || ! "$network_sha" =~ ^[a-f0-9]{64}$ || -n "$extra" ]]; then
    error "The active API network binding could not be canonicalized."
    return 1
  fi
  NETWORK_CONFIG="$network_config"
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256="$network_sha"
}

classpilot_tile_auth_observation_posture_sha256() {
  local snapshot="$1"
  TILE_AUTH_PLAN_OBSERVATION_SERVICE_SNAPSHOT="$snapshot" \
    EXPECTED_API_SERVICE="$SERVICE" \
    EXPECTED_WORKER_SERVICE="$WORKER_SERVICE" \
    EXPECTED_ENVIRONMENT="$ENV" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const crypto = require("crypto");
const lines = (process.env.TILE_AUTH_PLAN_OBSERVATION_SERVICE_SNAPSHOT || "")
  .split(/\r?\n/)
  .filter((line) => line.length > 0);
const expectedNames = new Set([
  process.env.EXPECTED_API_SERVICE,
  process.env.EXPECTED_WORKER_SERVICE,
]);
if (lines.length !== 2 || expectedNames.size !== 2) process.exit(1);
const services = lines.map((line) => {
  const fields = line.split("\t").map((value) => value.replace(/\r$/, ""));
  if (fields.length !== 9 || !expectedNames.has(fields[0])) process.exit(1);
  return {
    serviceName: fields[0],
    status: fields[1],
    desiredCount: Number(fields[2]),
    runningCount: Number(fields[3]),
    pendingCount: Number(fields[4]),
    deploymentCount: Number(fields[5]),
    taskDefinitionArn: fields[6],
    primaryTaskDefinitionArn: fields[7],
    rolloutState: fields[8],
  };
}).sort((left, right) => left.serviceName.localeCompare(right.serviceName));
if (new Set(services.map((service) => service.serviceName)).size !== 2 ||
    services.some((service) =>
      service.status !== "ACTIVE" ||
      service.rolloutState !== "COMPLETED" ||
      !Number.isSafeInteger(service.desiredCount) ||
      service.desiredCount < 1 ||
      service.runningCount !== service.desiredCount ||
      service.pendingCount !== 0 ||
      service.deploymentCount !== 1 ||
      service.taskDefinitionArn !== service.primaryTaskDefinitionArn
    )) {
  process.exit(1);
}

const posture = {
  accountId: process.env.EXPECTED_ACCOUNT_ID,
  environment: process.env.EXPECTED_ENVIRONMENT,
  region: process.env.EXPECTED_REGION,
  services,
  version: "classpilot-tile-auth-plan-observation-posture-v1",
};
process.stdout.write(
  crypto.createHash("sha256")
    .update(JSON.stringify(posture), "utf8")
    .digest("hex")
);
NODE
}

classpilot_tile_auth_observation_status_envelope() {
  local status="$1"
  local sha256="$2"
  local failure_code="$3"
  OBSERVATION_STATUS="$status" \
    OBSERVATION_SHA256="$sha256" \
    OBSERVATION_FAILURE_CODE="$failure_code" node <<'NODE'
const status = process.env.OBSERVATION_STATUS;
const sha256 = process.env.OBSERVATION_SHA256 || null;
const failureCode = process.env.OBSERVATION_FAILURE_CODE || null;
if (!["verified", "failed"].includes(status) ||
    (status === "verified" &&
      (!/^[a-f0-9]{64}$/.test(sha256 || "") || failureCode !== null)) ||
    (status === "failed" && (sha256 !== null || failureCode === null))) {
  process.exit(1);
}
process.stdout.write(JSON.stringify({status, sha256, failureCode}));
NODE
}

set_classpilot_tile_auth_observation_final_evidence() {
  local variable_name="$1"
  local status="$2"
  local sha256="$3"
  local failure_code="$4"
  local fallback_failure_code="$5"
  local envelope
  if ! envelope=$(classpilot_tile_auth_observation_status_envelope \
    "$status" "$sha256" "$failure_code"); then
    printf -v "$variable_name" \
      '{"status":"failed","sha256":null,"failureCode":"%s"}' \
      "$fallback_failure_code"
    return 0
  fi
  printf -v "$variable_name" '%s' "$envelope"
  return 0
}

preflight_classpilot_tile_auth_plan_observation_admission() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  if [[ -z "${LOCALAPPDATA:-}" ]]; then
    error "LOCALAPPDATA is required for the ACL-restricted ClassPilot tile authorization observation attempt."
    return 1
  fi
  if ! production_backend_deploy_window_preflight \
    "before ClassPilot plan-gate observation admission" ||
     ! classpilot_tile_auth_plan_window_preflight; then
    return 1
  fi
  local expected_task_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api-emergency:[1-9][0-9]*$"
  if [[ ! "$API_ROLLOUT_TASK_DEF" =~ $expected_task_pattern ]]; then
    error "The ClassPilot tile authorization observation requires the exact freshly registered emergency task-definition ARN."
    return 1
  fi
}

create_and_inspect_classpilot_tile_auth_plan_observation_supersession() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  if [[ -z "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        ! "$LOCAL_SHA" =~ ^[a-f0-9]{40}$ ||
        ! "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" =~ ^[a-f0-9]{64}$ ||
        -z "$API_ROLLOUT_TASK_DEF" ||
        -z "$WORKER_CANDIDATE_TASK_DEF" ||
        -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" ||
        -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" ]]; then
    error "The fresh observation target identity is incomplete; refusing historical reread supersession."
    return 1
  fi

  TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID="supersede-${TILE_AUTH_PLAN_OBSERVATION_ID}"
  local target_args=(
    --target-observation-id "$TILE_AUTH_PLAN_OBSERVATION_ID"
    --target-application-git-sha "$LOCAL_SHA"
    --target-image-digest "$DIGEST"
    --target-api-task-definition-arn "$API_ROLLOUT_TASK_DEF"
    --target-worker-task-definition-arn "$WORKER_CANDIDATE_TASK_DEF"
    --target-active-api-task-definition-arn "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
    --target-active-worker-task-definition-arn "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
    --target-network-configuration-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"
    --target-production-posture-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256"
  )

  local create_summary create_binding create_schema create_path create_sha create_id
  local create_source_reread create_target_observation create_expires
  local create_admission create_deploy create_diagnostic create_certification
  local create_scope create_created create_task_launches
  local extra
  if ! create_summary=$(MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation-evidence-reread.mjs" \
    supersede \
    --reread-packet-path "$CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD" \
    --expected-reread-packet-sha256 "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD_SHA256" \
    --supersession-id "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID" \
    "${target_args[@]}" 2>/dev/null); then
    error "The exact historical observation reread could not be superseded for this fresh observation."
    return 1
  fi
  if ! create_binding=$(CLASSPILOT_SUPERSESSION_SUMMARY="$create_summary" node <<'NODE'
const value = JSON.parse(process.env.CLASSPILOT_SUPERSESSION_SUMMARY || "null");
const keys = [
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "eligibleForFreshObservationAdmission",
  "createdAtUtc",
  "expiresAtUtc",
  "path",
  "schemaVersion",
  "sha256",
  "scope",
  "sourceRereadId",
  "supersessionId",
  "taskLaunchCount",
  "targetObservationId",
  "version",
].sort();
const createdAt = Date.parse(value?.createdAtUtc);
const expiresAt = Date.parse(value?.expiresAtUtc);
if (JSON.stringify(Object.keys(value || {}).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.version !==
      "classpilot-tile-auth-plan-observation-reread-supersession-v1" ||
    value.scope !== "fresh_observation_admission_only" ||
    value.taskLaunchCount !== 0 ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^([A-Za-z]:[\\/]|\/)/.test(value.path) ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.supersessionId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.sourceRereadId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.targetObservationId || "") ||
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== value.createdAtUtc ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAtUtc ||
    createdAt >= expiresAt ||
    expiresAt <= Date.now() ||
    value.eligibleForFreshObservationAdmission !== true ||
    value.eligibleForDeployment !== false ||
    value.eligibleForDiagnostic !== false ||
    value.eligibleForCertification !== false) process.exit(1);
process.stdout.write([
  String(value.schemaVersion),
  value.path,
  value.sha256,
  value.supersessionId,
  value.sourceRereadId,
  value.targetObservationId,
  value.scope,
  value.createdAtUtc,
  value.expiresAtUtc,
  String(value.taskLaunchCount),
  String(value.eligibleForFreshObservationAdmission),
  String(value.eligibleForDeployment),
  String(value.eligibleForDiagnostic),
  String(value.eligibleForCertification),
].join("\t"));
NODE
  ); then
    error "The historical observation reread supersession summary was malformed."
    return 1
  fi
  IFS=$'\t' read -r create_schema create_path create_sha create_id \
    create_source_reread create_target_observation create_scope create_created \
    create_expires create_task_launches create_admission create_deploy \
    create_diagnostic create_certification extra <<< "$create_binding"
  if [[ "$create_schema" != "1" ||
        "$create_id" != "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID" ||
        "$create_target_observation" != "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        "$create_scope" != "fresh_observation_admission_only" ||
        "$create_task_launches" != "0" ||
        "$create_admission" != "true" || "$create_deploy" != "false" ||
        "$create_diagnostic" != "false" ||
        "$create_certification" != "false" || -n "$extra" ]]; then
    error "The historical observation reread supersession target was ambiguous."
    return 1
  fi

  local inspect_summary inspect_binding inspect_schema inspect_path inspect_sha
  local inspect_id
  local inspect_source_reread inspect_target_observation inspect_expires
  local inspect_admission inspect_deploy inspect_diagnostic
  local inspect_certification inspect_scope inspect_created
  local inspect_task_launches
  if ! inspect_summary=$(MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation-evidence-reread.mjs" \
    inspect-supersession \
    --packet-path "$create_path" \
    --expected-packet-sha256 "$create_sha" \
    "${target_args[@]}" 2>/dev/null); then
    error "The one-shot historical observation reread supersession failed independent inspection."
    return 1
  fi
  if ! inspect_binding=$(CLASSPILOT_SUPERSESSION_SUMMARY="$inspect_summary" node <<'NODE'
const value = JSON.parse(process.env.CLASSPILOT_SUPERSESSION_SUMMARY || "null");
const keys = [
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "eligibleForFreshObservationAdmission",
  "createdAtUtc",
  "expiresAtUtc",
  "path",
  "schemaVersion",
  "sha256",
  "scope",
  "sourceRereadId",
  "supersessionId",
  "taskLaunchCount",
  "targetObservationId",
  "version",
].sort();
const createdAt = Date.parse(value?.createdAtUtc);
const expiresAt = Date.parse(value?.expiresAtUtc);
if (JSON.stringify(Object.keys(value || {}).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.version !==
      "classpilot-tile-auth-plan-observation-reread-supersession-v1" ||
    value.scope !== "fresh_observation_admission_only" ||
    value.taskLaunchCount !== 0 ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^([A-Za-z]:[\\/]|\/)/.test(value.path) ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.supersessionId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.sourceRereadId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.targetObservationId || "") ||
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== value.createdAtUtc ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAtUtc ||
    createdAt >= expiresAt ||
    expiresAt <= Date.now() ||
    value.eligibleForFreshObservationAdmission !== true ||
    value.eligibleForDeployment !== false ||
    value.eligibleForDiagnostic !== false ||
    value.eligibleForCertification !== false) process.exit(1);
process.stdout.write([
  String(value.schemaVersion),
  value.path,
  value.sha256,
  value.supersessionId,
  value.sourceRereadId,
  value.targetObservationId,
  value.scope,
  value.createdAtUtc,
  value.expiresAtUtc,
  String(value.taskLaunchCount),
  String(value.eligibleForFreshObservationAdmission),
  String(value.eligibleForDeployment),
  String(value.eligibleForDiagnostic),
  String(value.eligibleForCertification),
].join("\t"));
NODE
  ); then
    error "The independently inspected historical observation reread supersession summary was malformed."
    return 1
  fi
  IFS=$'\t' read -r inspect_schema inspect_path inspect_sha inspect_id \
    inspect_source_reread inspect_target_observation inspect_scope \
    inspect_created inspect_expires inspect_task_launches inspect_admission \
    inspect_deploy inspect_diagnostic inspect_certification extra \
    <<< "$inspect_binding"
  if [[ "$inspect_schema" != "$create_schema" ||
        "$inspect_path" != "$create_path" || "$inspect_sha" != "$create_sha" ||
        "$inspect_id" != "$create_id" ||
        "$inspect_source_reread" != "$create_source_reread" ||
        "$inspect_target_observation" != "$create_target_observation" ||
        "$inspect_scope" != "$create_scope" ||
        "$inspect_created" != "$create_created" ||
        "$inspect_expires" != "$create_expires" ||
        "$inspect_task_launches" != "$create_task_launches" ||
        "$inspect_admission" != "true" || "$inspect_deploy" != "false" ||
        "$inspect_diagnostic" != "false" ||
        "$inspect_certification" != "false" || -n "$extra" ]]; then
    error "The historical observation reread supersession changed between creation and independent inspection."
    return 1
  fi

  TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH="$inspect_path"
  TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_SHA256="$inspect_sha"
  success "Bound the one-shot historical reread supersession to observation ${TILE_AUTH_PLAN_OBSERVATION_ID} (packet=${inspect_path}, packetSha256=${inspect_sha}, eligibleForDeployment=false, eligibleForDiagnostic=false, eligibleForCertification=false)"
}

reinspect_classpilot_tile_auth_plan_observation_supersession_before_launch() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  if [[ -z "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID" != "supersede-${TILE_AUTH_PLAN_OBSERVATION_ID}" ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH" ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH" =~ ^([A-Za-z]:[\\/]|/) ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_SHA256" =~ ^[a-f0-9]{64}$ ||
        ! "$LOCAL_SHA" =~ ^[a-f0-9]{40}$ ||
        ! "$DIGEST" =~ ^sha256:[a-f0-9]{64}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" =~ ^[a-f0-9]{64}$ ||
        -z "$API_ROLLOUT_TASK_DEF" ||
        -z "$WORKER_CANDIDATE_TASK_DEF" ||
        -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" ||
        -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" ]]; then
    error "The bound historical observation reread supersession is incomplete at the task-launch boundary."
    return 1
  fi

  local target_args=(
    --target-observation-id "$TILE_AUTH_PLAN_OBSERVATION_ID"
    --target-application-git-sha "$LOCAL_SHA"
    --target-image-digest "$DIGEST"
    --target-api-task-definition-arn "$API_ROLLOUT_TASK_DEF"
    --target-worker-task-definition-arn "$WORKER_CANDIDATE_TASK_DEF"
    --target-active-api-task-definition-arn "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
    --target-active-worker-task-definition-arn "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
    --target-network-configuration-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"
    --target-production-posture-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256"
  )

  local inspect_summary inspect_binding inspect_schema inspect_path inspect_sha
  local inspect_id inspect_source_reread inspect_target_observation
  local inspect_scope inspect_created inspect_expires inspect_task_launches
  local inspect_admission inspect_deploy inspect_diagnostic
  local inspect_certification extra
  if ! inspect_summary=$(MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*" node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation-evidence-reread.mjs" \
    inspect-supersession \
    --packet-path "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH" \
    --expected-packet-sha256 "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_SHA256" \
    "${target_args[@]}" 2>/dev/null); then
    error "The historical observation reread supersession failed its immediate prelaunch inspection."
    return 1
  fi
  if ! inspect_binding=$(CLASSPILOT_SUPERSESSION_SUMMARY="$inspect_summary" node <<'NODE'
const value = JSON.parse(process.env.CLASSPILOT_SUPERSESSION_SUMMARY || "null");
const keys = [
  "eligibleForCertification",
  "eligibleForDeployment",
  "eligibleForDiagnostic",
  "eligibleForFreshObservationAdmission",
  "createdAtUtc",
  "expiresAtUtc",
  "path",
  "schemaVersion",
  "sha256",
  "scope",
  "sourceRereadId",
  "supersessionId",
  "taskLaunchCount",
  "targetObservationId",
  "version",
].sort();
const createdAt = Date.parse(value?.createdAtUtc);
const expiresAt = Date.parse(value?.expiresAtUtc);
if (JSON.stringify(Object.keys(value || {}).sort()) !== JSON.stringify(keys) ||
    value.schemaVersion !== 1 ||
    value.version !==
      "classpilot-tile-auth-plan-observation-reread-supersession-v1" ||
    value.scope !== "fresh_observation_admission_only" ||
    value.taskLaunchCount !== 0 ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^([A-Za-z]:[\\/]|\/)/.test(value.path) ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.supersessionId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.sourceRereadId || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.targetObservationId || "") ||
    !Number.isFinite(createdAt) ||
    new Date(createdAt).toISOString() !== value.createdAtUtc ||
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== value.expiresAtUtc ||
    createdAt >= expiresAt ||
    expiresAt <= Date.now() ||
    value.eligibleForFreshObservationAdmission !== true ||
    value.eligibleForDeployment !== false ||
    value.eligibleForDiagnostic !== false ||
    value.eligibleForCertification !== false) process.exit(1);
process.stdout.write([
  String(value.schemaVersion),
  value.path,
  value.sha256,
  value.supersessionId,
  value.sourceRereadId,
  value.targetObservationId,
  value.scope,
  value.createdAtUtc,
  value.expiresAtUtc,
  String(value.taskLaunchCount),
  String(value.eligibleForFreshObservationAdmission),
  String(value.eligibleForDeployment),
  String(value.eligibleForDiagnostic),
  String(value.eligibleForCertification),
].join("\t"));
NODE
  ); then
    error "The immediate prelaunch historical reread supersession summary was malformed or expired."
    return 1
  fi
  IFS=$'\t' read -r inspect_schema inspect_path inspect_sha inspect_id \
    inspect_source_reread inspect_target_observation inspect_scope \
    inspect_created inspect_expires inspect_task_launches inspect_admission \
    inspect_deploy inspect_diagnostic inspect_certification extra \
    <<< "$inspect_binding"
  if [[ "$inspect_schema" != "1" ||
        "$inspect_path" != "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_PATH" ||
        "$inspect_sha" != "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_SHA256" ||
        "$inspect_id" != "$TILE_AUTH_PLAN_OBSERVATION_SUPERSESSION_ID" ||
        "$inspect_target_observation" != "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        "$inspect_scope" != "fresh_observation_admission_only" ||
        "$inspect_task_launches" != "0" ||
        "$inspect_admission" != "true" || "$inspect_deploy" != "false" ||
        "$inspect_diagnostic" != "false" ||
        "$inspect_certification" != "false" || -n "$extra" ]]; then
    error "The historical observation reread supersession changed before task launch."
    return 1
  fi
}

initialize_classpilot_tile_auth_plan_observation() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi

  TILE_AUTH_PLAN_OBSERVATION_ID="tile-plan-observe-$(date -u +%Y%m%dt%H%M%Sz)-${LOCAL_SHA:0:12}"
  if [[ ! "$TILE_AUTH_PLAN_OBSERVATION_ID" =~ ^[a-z0-9][a-z0-9-]{7,127}$ ||
        ! "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    error "The ClassPilot tile authorization observation attempt binding is malformed."
    return 1
  fi
  TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256="$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256"

  local snapshot posture_sha
  if ! snapshot=$(production_service_snapshot) ||
     ! validate_production_service_snapshot \
       "$snapshot" \
       "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" \
       "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ||
     ! posture_sha=$(classpilot_tile_auth_observation_posture_sha256 "$snapshot") ||
     [[ ! "$posture_sha" =~ ^[a-f0-9]{64}$ ]]; then
    error "The ClassPilot tile authorization observation could not bind the initial production posture."
    return 1
  fi
  TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256="$posture_sha"

  TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT="${LOCALAPPDATA}/SchoolPilot/load-gates/tile-auth-observations/${LOCAL_SHA}/${TILE_AUTH_PLAN_OBSERVATION_ID}"
  local identity_args=(
    --observation-id "$TILE_AUTH_PLAN_OBSERVATION_ID"
    --application-sha "$LOCAL_SHA"
    --image-digest "$DIGEST"
    --candidate-api-task-definition-arn "$API_ROLLOUT_TASK_DEF"
    --candidate-worker-task-definition-arn "$WORKER_CANDIDATE_TASK_DEF"
    --active-api-task-definition-arn "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
    --active-worker-task-definition-arn "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
    --initial-network-configuration-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"
    --initial-production-posture-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256"
  )
  local admit_summary admit_binding attempt_path attempt_sha attempt_id
  local eligible_deploy eligible_diagnostic eligible_certification extra
  attempt_path="${TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT}/attempt/classpilot-tile-auth-plan-observation-attempt.private.json"
  if ! admit_summary=$(node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation.mjs" admit \
    --output "$TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT" \
    "${identity_args[@]}" 2>/dev/null); then
    error "The immutable ClassPilot tile authorization observation attempt could not be admitted."
    return 1
  fi
  TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_ADMITTED=true
  TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH="$attempt_path"
  if ! attempt_sha=$(CLASSPILOT_OBSERVATION_ATTEMPT_PATH="$attempt_path" node <<'NODE'
const { createHash } = require("crypto");
const fs = require("fs");
const bytes = fs.readFileSync(
  process.env.CLASSPILOT_OBSERVATION_ATTEMPT_PATH
);
process.stdout.write(createHash("sha256").update(bytes).digest("hex"));
NODE
  ) || [[ ! "$attempt_sha" =~ ^[a-f0-9]{64}$ ]]; then
    TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED=true
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    error "The immutable ClassPilot tile authorization observation attempt could not be hash-bound."
    return 0
  fi
  TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256="$attempt_sha"

  if ! admit_binding=$(CLASSPILOT_OBSERVATION_ATTEMPT_SUMMARY="$admit_summary" \
    CLASSPILOT_OBSERVATION_ATTEMPT_PATH="$attempt_path" \
    EXPECTED_ATTEMPT_SHA256="$attempt_sha" \
    EXPECTED_OBSERVATION_ID="$TILE_AUTH_PLAN_OBSERVATION_ID" \
    EXPECTED_APPLICATION_SHA="$LOCAL_SHA" \
    EXPECTED_IMAGE_DIGEST="$DIGEST" \
    EXPECTED_CANDIDATE_API_TASK_DEFINITION="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_CANDIDATE_WORKER_TASK_DEFINITION="$WORKER_CANDIDATE_TASK_DEF" \
    EXPECTED_ACTIVE_API_TASK_DEFINITION="$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" \
    EXPECTED_ACTIVE_WORKER_TASK_DEFINITION="$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" \
    EXPECTED_INITIAL_NETWORK_SHA256="$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" \
    EXPECTED_INITIAL_POSTURE_SHA256="$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" \
    node --input-type=module - \
      "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation.mjs" <<'NODE'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const attemptPath = path.resolve(process.env.CLASSPILOT_OBSERVATION_ATTEMPT_PATH);
const bytes = fs.readFileSync(attemptPath);
const attemptSha256 = createHash("sha256").update(bytes).digest("hex");
if (attemptSha256 !== process.env.EXPECTED_ATTEMPT_SHA256) process.exit(1);
const manager = await import(
  pathToFileURL(path.resolve(process.argv[2])).href
);
const expected = {
  expectedAttemptRecordSha256: attemptSha256,
  observationId: process.env.EXPECTED_OBSERVATION_ID,
  applicationGitSha: process.env.EXPECTED_APPLICATION_SHA,
  imageDigest: process.env.EXPECTED_IMAGE_DIGEST,
  candidateApiTaskDefinitionArn:
    process.env.EXPECTED_CANDIDATE_API_TASK_DEFINITION,
  candidateWorkerTaskDefinitionArn:
    process.env.EXPECTED_CANDIDATE_WORKER_TASK_DEFINITION,
  activeApiTaskDefinitionArn:
    process.env.EXPECTED_ACTIVE_API_TASK_DEFINITION,
  activeWorkerTaskDefinitionArn:
    process.env.EXPECTED_ACTIVE_WORKER_TASK_DEFINITION,
  initialNetworkConfigurationSha256:
    process.env.EXPECTED_INITIAL_NETWORK_SHA256,
  initialProductionPostureSha256:
    process.env.EXPECTED_INITIAL_POSTURE_SHA256,
};
const inspected =
  manager.inspectClasspilotTileAuthorizationPlanObservationAttempt(
    attemptPath,
    expected
  );
const admitted = JSON.parse(
  process.env.CLASSPILOT_OBSERVATION_ATTEMPT_SUMMARY || "null"
);
if (admitted?.path !== inspected.path ||
    admitted?.sha256 !== inspected.sha256 ||
    admitted?.observationId !== inspected.observationId ||
    admitted?.schemaVersion !== inspected.schemaVersion ||
    admitted?.version !== inspected.version ||
    admitted?.eligibleForDeployment !== false ||
    admitted?.eligibleForDiagnostic !== false ||
    admitted?.eligibleForCertification !== false) {
  process.exit(1);
}
process.stdout.write([
  inspected.path,
  inspected.sha256,
  inspected.observationId,
  String(inspected.eligibleForDeployment),
  String(inspected.eligibleForDiagnostic),
  String(inspected.eligibleForCertification),
].join("\t"));
NODE
  ); then
    TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED=true
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    error "The immutable ClassPilot tile authorization observation attempt failed independent inspection."
    return 0
  fi
  IFS=$'\t' read -r attempt_path attempt_sha attempt_id eligible_deploy eligible_diagnostic eligible_certification extra <<< "$admit_binding"
  if [[ -z "$attempt_path" || ! "$attempt_sha" =~ ^[a-f0-9]{64}$ ||
        "$attempt_id" != "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        "$eligible_deploy" != "false" || "$eligible_diagnostic" != "false" ||
        "$eligible_certification" != "false" || -n "$extra" ]]; then
    TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED=true
    set_classpilot_tile_auth_observation_collection_failure \
      "terminal_task_unavailable"
    error "The immutable ClassPilot tile authorization observation attempt binding was ambiguous."
    return 0
  fi
  TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH="$attempt_path"
  TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256="$attempt_sha"

  TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT="${TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT}/controller"
  TILE_AUTH_PLAN_OBSERVATION_TASK_PATH="${TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT}/run-task.private.json"
  TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH="${TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT}/terminal-task.private.json"
  TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH="${TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT}/log-configuration.private.json"
  if ! MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' node --input-type=module - \
    "$SCRIPT_DIR/load/prepare-classpilot-load-test.mjs" \
    "$TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";
const helper = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const requested = path.resolve(process.argv[3]);
const prepared = helper.preparePrivateOutputDirectory(requested);
if (prepared !== requested) process.exit(1);
NODE
  then
    TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED=true
    set_classpilot_tile_auth_observation_collection_failure \
      "collector_start_unavailable"
    error "The ACL-private ClassPilot tile authorization observation controller workspace could not be prepared."
    return 0
  fi
}

capture_classpilot_tile_auth_observation_final_network() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  local expected_network_sha="$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"
  NETWORK_CONFIG=""
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
  if ! resolve_classpilot_tile_auth_candidate_network; then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON \
      "failed" "" "network_unavailable" "network_unavailable"
  elif [[ "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" != "$expected_network_sha" ]]; then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON \
      "failed" "" "network_drift" "network_unavailable"
  else
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON \
      "verified" "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" "" \
      "network_unavailable"
  fi
  return 0
}

capture_classpilot_tile_auth_observation_final_posture() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  local snapshot posture_sha
  if ! snapshot=$(production_service_snapshot); then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
      "failed" "" "production_posture_unavailable" \
      "production_posture_unavailable"
  elif ! validate_production_service_snapshot \
    "$snapshot" \
    "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" \
    "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION"; then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
      "failed" "" "production_posture_drift" \
      "production_posture_unavailable"
  elif ! posture_sha=$(classpilot_tile_auth_observation_posture_sha256 "$snapshot") ||
       [[ ! "$posture_sha" =~ ^[a-f0-9]{64}$ ]]; then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
      "failed" "" "production_posture_unavailable" \
      "production_posture_unavailable"
  elif [[ "$posture_sha" != "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" ]]; then
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
      "failed" "" "production_posture_drift" \
      "production_posture_unavailable"
  else
    set_classpilot_tile_auth_observation_final_evidence \
      TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON \
      "verified" "$posture_sha" "" \
      "production_posture_unavailable"
  fi
  return 0
}

assert_classpilot_rehearsal_network_unchanged() {
  local expected_network_sha="${1:-$TILE_AUTH_PLAN_REHEARSAL_CONSUMED_NETWORK_SHA256}"
  if [[ -z "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ]]; then
    return 0
  fi
  if [[ ! "$expected_network_sha" =~ ^[a-f0-9]{64}$ ]]; then
    error "The expected ClassPilot rehearsal network binding is unavailable."
    return 1
  fi

  NETWORK_CONFIG=""
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
  if ! resolve_classpilot_tile_auth_candidate_network; then
    error "The active API network configuration could not be revalidated against the consumed candidate rehearsal."
    return 1
  fi
  if [[ "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" != "$expected_network_sha" ]]; then
    error "The active API network configuration drifted from the candidate rehearsal."
    return 1
  fi
}

assert_capacity_acceptance_network_unchanged() {
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" != true ]]; then
    return 0
  fi
  if [[ ! "$CAPACITY_ACCEPTANCE_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    error "The initial capacity-acceptance candidate network binding is unavailable."
    return 1
  fi

  local expected_network_sha="$CAPACITY_ACCEPTANCE_NETWORK_SHA256"
  NETWORK_CONFIG=""
  TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256=""
  if ! resolve_classpilot_tile_auth_candidate_network; then
    error "The active API network configuration could not be revalidated for the capacity-acceptance release."
    return 1
  fi
  if [[ "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" != "$expected_network_sha" ]]; then
    error "The active API network configuration drifted after capacity-acceptance candidate registration."
    return 1
  fi
}

canonical_classpilot_candidate_source_task_definition_arn() {
  local ref="${1%$'\r'}"
  local kind="$2"
  local normalized family revision

  if [[ ! "$ref" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]]; then
    return 1
  fi
  if ! normalized=$(normalize_task_definition_ref "$ref"); then
    return 1
  fi
  family="${normalized%:*}"
  revision="${normalized##*:}"
  case "$kind" in
    api)
      if [[ "$family" != "$SERVICE" && "$family" != "${SERVICE}-emergency" ]]; then
        return 1
      fi
      ;;
    worker)
      if [[ "$family" != "$WORKER_SERVICE" ]]; then
        return 1
      fi
      ;;
    *)
      return 1
      ;;
  esac

  printf 'arn:aws:ecs:%s:%s:task-definition/%s:%s\n' \
    "$REGION" "$ACCOUNT_ID" "$family" "$revision"
}

resolve_classpilot_candidate_source_task_definitions() {
  local api_ref worker_ref

  if [[ "$ENV" == "production" ]]; then
    if [[ -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
          -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ||
          -z "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" ||
          -z "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" ||
          "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
          "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ||
          "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN" ||
          "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN" ]]; then
      error "The immutable serving API/worker task-definition sources are unavailable or drifted."
      return 1
    fi
    api_ref="$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
    worker_ref="$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
  else
    if ! api_ref=$(aws ecs describe-services \
        --cluster "$CLUSTER" \
        --services "$SERVICE" \
        --query 'services[0].taskDefinition' \
        --output text \
        --region "$REGION" \
        --no-cli-pager) ||
      ! worker_ref=$(aws ecs describe-services \
        --cluster "$CLUSTER" \
        --services "$WORKER_SERVICE" \
        --query 'services[0].taskDefinition' \
        --output text \
        --region "$REGION" \
        --no-cli-pager); then
      error "Could not resolve the immutable serving API/worker task-definition sources."
      return 1
    fi
  fi

  if ! API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN=$(
      canonical_classpilot_candidate_source_task_definition_arn "$api_ref" api
    ) ||
    ! WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN=$(
      canonical_classpilot_candidate_source_task_definition_arn "$worker_ref" worker
    ); then
    error "The serving API/worker task-definition sources were not exact immutable revisions in the expected account, region, or families."
    return 1
  fi
}

describe_exact_classpilot_candidate_task_definition() {
  local task_definition_arn="$1"
  local output_path="$2"
  if [[ ! "$task_definition_arn" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/[A-Za-z0-9_-]+:[1-9][0-9]*$ ]]; then
    error "A candidate task-definition source was not an exact immutable ARN."
    return 1
  fi
  aws ecs describe-task-definition \
    --task-definition "$task_definition_arn" \
    --query taskDefinition \
    --output json \
    --region "$REGION" \
    --no-cli-pager > "$output_path"
}

preflight_rls_table_enablement_sources() {
  if [[ -z "$ENABLE_RLS_TABLE" ]]; then
    return 0
  fi
  if ! describe_exact_classpilot_candidate_task_definition \
      "$API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
      .rls-api-source.json ||
    ! describe_exact_classpilot_candidate_task_definition \
      "$WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
      .rls-worker-source.json; then
    error "Could not read both exact live task definitions for RLS table enablement."
    return 1
  fi
  if ! node "$SCRIPT_DIR/enforce-deploy-rls-allowlist.mjs" preflight \
      --api-task-definition .rls-api-source.json \
      --worker-task-definition .rls-worker-source.json \
      --table "$ENABLE_RLS_TABLE" > /dev/null; then
    error "The live API/worker RLS contract is not eligible for the reviewed table enablement."
    return 1
  fi
  success "Reviewed RLS allowlist delta: +${ENABLE_RLS_TABLE} (master remains true; no existing table changes)"
}

register_classpilot_candidate_worker_task_definition() {
  info "Rendering scheduler worker task definition for the inactive candidate..."
  if ! describe_exact_classpilot_candidate_task_definition \
      "$WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
      .worker-taskdef-current.json ||
    ! describe_exact_classpilot_candidate_task_definition \
      "$STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN" \
      .worker-env-source.json; then
    error "Could not read the source task definitions for the scheduler-worker candidate."
    return 1
  fi
  if ! IMAGE_REF="${ECR_REPO}@${DIGEST}" \
    EXPECTED_WORKER_SOURCE_ARN="$WORKER_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
    EXPECTED_API_SOURCE_ARN="$STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN" node -e '
    const fs = require("fs");
    const td = JSON.parse(fs.readFileSync(".worker-taskdef-current.json", "utf8"));
    const api = JSON.parse(fs.readFileSync(".worker-env-source.json", "utf8"));
    if (td.taskDefinitionArn !== process.env.EXPECTED_WORKER_SOURCE_ARN ||
        api.taskDefinitionArn !== process.env.EXPECTED_API_SOURCE_ARN ||
        td.status !== "ACTIVE" || api.status !== "ACTIVE") {
      throw new Error("Worker candidate sources do not match their exact immutable task definitions");
    }
    ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"].forEach(k => delete td[k]);
    function mergeNamed(base = [], overlay = []) {
      const merged = new Map();
      for (const item of base) merged.set(item.name, item);
      for (const item of overlay) merged.set(item.name, item);
      return [...merged.values()];
    }
    function dedupeEnvAgainstSecrets(container) {
      const secretNames = new Set((container.secrets || []).map(item => item.name));
      container.environment = (container.environment || []).filter(
        item => !secretNames.has(item.name)
      );
    }
    function reconcileOptionalSecrets(container, sourceContainer) {
      const optionalNames = new Set(["GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"]);
      const retiredNames = new Set(["OPENAI_API_KEY"]);
      const enabledNames = new Set((sourceContainer.secrets || []).map(item => item.name));
      container.secrets = (container.secrets || []).filter(
        item => !retiredNames.has(item.name) &&
          (!optionalNames.has(item.name) || enabledNames.has(item.name))
      );
      container.environment = (container.environment || []).filter(
        item => !retiredNames.has(item.name) &&
          (!optionalNames.has(item.name) || enabledNames.has(item.name))
      );
    }
    const container = td.containerDefinitions.find(
      c => c.name === "scheduler-worker"
    ) || td.containerDefinitions[0];
    const apiContainer = (api.containerDefinitions || []).find(
      c => c.name === "api"
    ) || api.containerDefinitions?.[0] || {};
    if (!container || !process.env.IMAGE_REF?.includes("@sha256:")) process.exit(1);
    container.image = process.env.IMAGE_REF;
    container.environment = mergeNamed(apiContainer.environment, container.environment);
    container.secrets = mergeNamed(apiContainer.secrets, container.secrets);
    reconcileOptionalSecrets(container, apiContainer);
    dedupeEnvAgainstSecrets(container);
    fs.writeFileSync(".worker-taskdef-new.json", JSON.stringify(td));
  '; then
    error "The scheduler-worker candidate task definition could not be rendered safely."
    return 1
  fi
  if [[ -n "$ENABLE_RLS_TABLE" ]]; then
    if ! node "$SCRIPT_DIR/enforce-deploy-rls-allowlist.mjs" add \
        --task-definition .worker-taskdef-new.json \
        --container scheduler-worker \
        --table "$ENABLE_RLS_TABLE"; then
      error "The scheduler-worker candidate could not apply the reviewed RLS allowlist delta."
      return 1
    fi
  fi

  local worker_arn
  if ! worker_arn=$(aws ecs register-task-definition \
    --cli-input-json file://.worker-taskdef-new.json \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text \
    --region "$REGION" \
    --no-cli-pager); then
    error "The scheduler-worker candidate task definition could not be registered."
    return 1
  fi
  local expected_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${WORKER_SERVICE}:([1-9][0-9]*)$"
  if [[ ! "$worker_arn" =~ $expected_pattern ]]; then
    error "The registered scheduler-worker candidate ARN was malformed."
    return 1
  fi
  WORKER_CANDIDATE_TASK_DEF="$worker_arn"
  WORKER_NEW_REV="${BASH_REMATCH[1]}"
  success "Registered inactive scheduler-worker candidate ${WORKER_CANDIDATE_TASK_DEF} (image pinned by digest)"
}

verify_registered_rls_table_enablement_candidates() {
  if [[ -z "$ENABLE_RLS_TABLE" ]]; then
    return 0
  fi
  if ! describe_exact_classpilot_candidate_task_definition \
      "$STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN" \
      .rls-standard-api-registered.json ||
    ! describe_exact_classpilot_candidate_task_definition \
      "$EMERGENCY_TASK_DEF_ARN" \
      .rls-emergency-api-registered.json ||
    ! describe_exact_classpilot_candidate_task_definition \
      "$WORKER_CANDIDATE_TASK_DEF" \
      .rls-worker-registered.json; then
    error "Could not read all exact registered candidates for RLS verification."
    return 1
  fi
  if ! node "$SCRIPT_DIR/enforce-deploy-rls-allowlist.mjs" verify-candidates \
      --api-source-task-definition .rls-api-source.json \
      --worker-source-task-definition .rls-worker-source.json \
      --api-task-definition .rls-standard-api-registered.json \
      --emergency-task-definition .rls-emergency-api-registered.json \
      --worker-task-definition .rls-worker-registered.json \
      --table "$ENABLE_RLS_TABLE"; then
    error "Registered API, emergency API, and scheduler-worker candidates did not retain the exact reviewed RLS allowlist delta."
    return 1
  fi
  success "Registered RLS allowlists verified: +${ENABLE_RLS_TABLE} on API, emergency API, and scheduler worker"
}

verify_classpilot_rehearsed_candidates() {
  local tag_digest
  if ! tag_digest=$(aws ecr describe-images \
    --repository-name "${NAME}-api" \
    --image-ids imageTag="${IMAGE_TAG}" \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --region "$REGION" \
    --no-cli-pager) ||
    [[ "$tag_digest" != "$DIGEST" ]]; then
    error "The merged-SHA ECR tag no longer resolves to the rehearsed image digest."
    return 1
  fi
  if ! aws ecs describe-task-definition \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --query taskDefinition \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .tile-auth-plan-rehearsed-api.json ||
    ! aws ecs describe-task-definition \
      --task-definition "$WORKER_CANDIDATE_TASK_DEF" \
      --query taskDefinition \
      --output json \
      --region "$REGION" \
      --no-cli-pager > .tile-auth-plan-rehearsed-worker.json; then
    error "The exact rehearsed candidate task definitions could not be read."
    return 1
  fi
  if ! EXPECTED_API_ARN="$API_ROLLOUT_TASK_DEF" \
    EXPECTED_WORKER_ARN="$WORKER_CANDIDATE_TASK_DEF" \
    EXPECTED_IMAGE="${ECR_REPO}@${DIGEST}" node -e '
    const fs = require("fs");
    const api = JSON.parse(fs.readFileSync(".tile-auth-plan-rehearsed-api.json", "utf8"));
    const worker = JSON.parse(fs.readFileSync(".tile-auth-plan-rehearsed-worker.json", "utf8"));
    const apiContainers = (api.containerDefinitions || []).filter(c => c.name === "api");
    const workerContainers = (worker.containerDefinitions || []).filter(
      c => c.name === "scheduler-worker"
    );
    const apiContainer = apiContainers[0];
    const workerContainer = workerContainers[0];
    const apiHardMemory = apiContainer?.memory;
    if (api.taskDefinitionArn !== process.env.EXPECTED_API_ARN ||
        worker.taskDefinitionArn !== process.env.EXPECTED_WORKER_ARN ||
        api.status !== "ACTIVE" || worker.status !== "ACTIVE" ||
        api.family !== "schoolpilot-production-api-emergency" ||
        worker.family !== "schoolpilot-production-scheduler-worker" ||
        String(api.cpu) !== "512" || String(api.memory) !== "2048" ||
        (apiHardMemory !== undefined && apiHardMemory !== null &&
          Number(apiHardMemory) < 2048) ||
        apiContainers.length !== 1 || workerContainers.length !== 1 ||
        apiContainer?.image !== process.env.EXPECTED_IMAGE ||
        workerContainer?.image !== process.env.EXPECTED_IMAGE) {
      process.exit(1);
    }
  '; then
    error "The rehearsed candidate definitions drifted from their bound digest, families, or launch-safe posture."
    return 1
  fi

  local definition_hashes api_sha worker_sha extra
  if ! definition_hashes=$(node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    function stable(value) {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.keys(value).sort().map(key => [key, stable(value[key])])
      );
    }
    function hash(filename) {
      const value = JSON.parse(fs.readFileSync(filename, "utf8"));
      return crypto.createHash("sha256")
        .update(JSON.stringify(stable(value)), "utf8").digest("hex");
    }
    process.stdout.write(
      `${hash(".tile-auth-plan-rehearsed-api.json")}\t` +
      `${hash(".tile-auth-plan-rehearsed-worker.json")}`
    );
  '); then
    error "The rehearsed candidate task-definition bindings could not be hashed."
    return 1
  fi
  IFS=$'\t' read -r api_sha worker_sha extra <<< "$definition_hashes"
  if [[ ! "$api_sha" =~ ^[a-f0-9]{64}$ ||
        ! "$worker_sha" =~ ^[a-f0-9]{64}$ || -n "$extra" ]]; then
    error "The rehearsed candidate task-definition hashes were malformed."
    return 1
  fi
  if [[ -n "$TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256" &&
        ( "$api_sha" != "$TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256" ||
          "$worker_sha" != "$TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256" ) ]]; then
    error "The exact candidate task definitions drifted from their rehearsal receipt."
    return 1
  fi
  TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256="$api_sha"
  TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256="$worker_sha"
}

parse_classpilot_rehearsal_binding() {
  local binding_json="$1"
  REHEARSAL_BINDING_JSON="$binding_json" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" \
    EXPECTED_API_FAMILY="${NAME}-api-emergency" \
    EXPECTED_WORKER_FAMILY="$WORKER_SERVICE" node <<'NODE'
const value = JSON.parse(process.env.REHEARSAL_BINDING_JSON || "null");
const hash = /^[a-f0-9]{64}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const region = process.env.EXPECTED_REGION;
const accountId = process.env.EXPECTED_ACCOUNT_ID;
const apiFamily = process.env.EXPECTED_API_FAMILY;
const workerFamily = process.env.EXPECTED_WORKER_FAMILY;
if (!/^[a-z]{2}-[a-z]+-\d$/.test(region || "") ||
    !/^\d{12}$/.test(accountId || "") ||
    !/^[A-Za-z0-9_-]+$/.test(apiFamily || "") ||
    !/^[A-Za-z0-9_-]+$/.test(workerFamily || "")) process.exit(1);
const hasExactRevision = (candidate, family) => {
  const prefix =
    `arn:aws:ecs:${region}:${accountId}:task-definition/${family}:`;
  return typeof candidate === "string" &&
    candidate.startsWith(prefix) &&
    /^[1-9]\d*$/.test(candidate.slice(prefix.length));
};
if (value?.schemaVersion !== 1 ||
    value?.version !== "classpilot-tile-auth-plan-rehearsal-v1" ||
    !hash.test(value.receiptSha256 || "") ||
    !digest.test(value.imageDigest || "") ||
    !hasExactRevision(value.candidateApiTaskDefinitionArn, apiFamily) ||
    !hash.test(value.candidateApiTaskDefinitionSha256 || "") ||
    !hasExactRevision(value.candidateWorkerTaskDefinitionArn, workerFamily) ||
    !hash.test(value.candidateWorkerTaskDefinitionSha256 || "") ||
    !hash.test(value.historyFallbackIdentitySha256 || "") ||
    !hash.test(value.queryIdentifierSha256 || "") ||
    !hash.test(value.preflightEvidenceSha256 || "") ||
    !hash.test(value.planEventsSha256 || "") ||
    !hash.test(value.sanitizedPlanReportSha256 || "") ||
    !hash.test(value.lifecycleEvidenceSha256 || "")) process.exit(1);
process.stdout.write([
  value.receiptSha256,
  value.imageDigest,
  value.candidateApiTaskDefinitionArn,
  value.candidateApiTaskDefinitionSha256,
  value.candidateWorkerTaskDefinitionArn,
  value.candidateWorkerTaskDefinitionSha256,
  value.historyFallbackIdentitySha256,
  value.queryIdentifierSha256,
].join("\t"));
NODE
}

admit_classpilot_tile_auth_plan_rehearsal_attempt() {
  local summary binding attempt_sha extra
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" != true &&
        -z "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ]]; then
    return 0
  fi
  if [[ "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED" == true ]]; then
    error "The ClassPilot tile authorization rehearsal attempt was already admitted in this process."
    return 1
  fi
  if ! summary=$(node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs" admit \
    --application-sha "$LOCAL_SHA" 2>/dev/null); then
    error "The single-use ClassPilot tile authorization rehearsal attempt could not be admitted."
    return 1
  fi
  if ! binding=$(REHEARSAL_ATTEMPT_JSON="$summary" \
    EXPECTED_APPLICATION_SHA="$LOCAL_SHA" node <<'NODE'
const value = JSON.parse(process.env.REHEARSAL_ATTEMPT_JSON || "null");
if (value?.schemaVersion !== 1 ||
    value?.version !== "classpilot-tile-auth-plan-rehearsal-attempt-v1" ||
    value?.applicationGitSha !== process.env.EXPECTED_APPLICATION_SHA ||
    !/^[a-f0-9]{64}$/.test(value?.sha256 || "")) process.exit(1);
process.stdout.write(value.sha256);
NODE
  ); then
    error "The ClassPilot tile authorization rehearsal admission evidence was malformed."
    return 1
  fi
  IFS=$'\t' read -r attempt_sha extra <<< "$binding"
  if [[ ! "$attempt_sha" =~ ^[a-f0-9]{64}$ || -n "$extra" ]]; then
    error "The ClassPilot tile authorization rehearsal admission hash was malformed."
    return 1
  fi
  TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256="$attempt_sha"
  TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED=true
  success "Admitted the one-attempt ClassPilot candidate rehearsal (admissionSha256=${attempt_sha})"
}

seal_classpilot_tile_auth_plan_rehearsal_terminal() {
  local outcome="$1"
  local summary binding status admission_sha receipt_sha extra
  if [[ "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED" != true ||
        "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_TERMINAL" == true ||
        ! "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
    return 1
  fi

  local command=(
    node "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs"
    terminal
    --application-sha "$LOCAL_SHA"
    --expected-admission-sha256 "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256"
    --outcome "$outcome"
  )
  if [[ "$outcome" == "passed" ]]; then
    if [[ -z "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_PATH" ||
          ! "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
      return 1
    fi
    command+=(
      --receipt "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_PATH"
      --receipt-sha256 "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256"
    )
  elif [[ "$outcome" != "failed" ]]; then
    return 1
  fi

  if ! summary=$("${command[@]}" 2>/dev/null); then
    return 1
  fi
  if ! binding=$(REHEARSAL_TERMINAL_JSON="$summary" \
    EXPECTED_APPLICATION_SHA="$LOCAL_SHA" \
    EXPECTED_ADMISSION_SHA="$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256" \
    EXPECTED_OUTCOME="$outcome" \
    EXPECTED_RECEIPT_SHA="$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256" node <<'NODE'
const value = JSON.parse(process.env.REHEARSAL_TERMINAL_JSON || "null");
const expectedReceipt =
  process.env.EXPECTED_OUTCOME === "passed"
    ? process.env.EXPECTED_RECEIPT_SHA
    : null;
if (value?.schemaVersion !== 1 ||
    value?.version !== "classpilot-tile-auth-plan-rehearsal-terminal-v1" ||
    value?.applicationGitSha !== process.env.EXPECTED_APPLICATION_SHA ||
    value?.admissionSha256 !== process.env.EXPECTED_ADMISSION_SHA ||
    value?.status !== process.env.EXPECTED_OUTCOME ||
    value?.receiptSha256 !== expectedReceipt ||
    !/^[a-f0-9]{64}$/.test(value?.sha256 || "")) process.exit(1);
process.stdout.write(
  `${value.status}\t${value.admissionSha256}\t${value.receiptSha256 ?? ""}`
);
NODE
  ); then
    return 1
  fi
  IFS=$'\t' read -r status admission_sha receipt_sha extra <<< "$binding"
  if [[ "$status" != "$outcome" ||
        "$admission_sha" != "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_SHA256" ||
        -n "$extra" ||
        ( "$outcome" == "passed" &&
          "$receipt_sha" != "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256" ) ||
        ( "$outcome" == "failed" && -n "$receipt_sha" ) ]]; then
    return 1
  fi
  TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_TERMINAL=true
}

seal_classpilot_tile_auth_plan_rehearsal_authoritative_failure() {
  if [[ ( "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" != true &&
          -z "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ) ||
        "$TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE" != true ]]; then
    return 0
  fi
  if [[ "$TILE_AUTH_PLAN_REHEARSAL_ATTEMPT_ADMITTED" != true ]] &&
     ! admit_classpilot_tile_auth_plan_rehearsal_attempt; then
    error "The authoritative ClassPilot candidate rehearsal failure could not be admitted."
    return 1
  fi
  if ! seal_classpilot_tile_auth_plan_rehearsal_terminal failed; then
    error "The authoritative ClassPilot candidate rehearsal failure could not be sealed."
    return 1
  fi
  success "Sealed the authoritative ClassPilot candidate rehearsal failure for this SHA."
}

run_classpilot_tile_auth_plan_predeploy_with_retry() {
  local include_base_preflight="$1"
  local attempt
  if [[ "$include_base_preflight" != true &&
        "$include_base_preflight" != false ]]; then
    return 1
  fi
  for attempt in 1 2; do
    TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE=false
    if [[ "$include_base_preflight" == true ]] &&
       ! run_classpilot_tile_auth_plan_base_preflight; then
      if [[ "$TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE" == true ]]; then
        seal_classpilot_tile_auth_plan_rehearsal_authoritative_failure
        return 1
      fi
      if [[ "$attempt" -lt 2 ]]; then
        warn "ClassPilot base-preflight evidence was unavailable before mutation; retrying the same SHA once."
        continue
      fi
      return 1
    fi
    if run_classpilot_tile_auth_plan_gate predeploy; then
      return 0
    fi
    if [[ "$TILE_AUTH_PLAN_REHEARSAL_AUTHORITATIVE_FAILURE" == true ]]; then
      seal_classpilot_tile_auth_plan_rehearsal_authoritative_failure
      return 1
    fi
    if [[ "$attempt" -lt 2 ]]; then
      warn "ClassPilot plan-gate evidence was unavailable before mutation; retrying the same SHA once."
      continue
    fi
    return 1
  done
  return 1
}

inspect_or_consume_classpilot_rehearsal_receipt() {
  local mode="$1"
  local summary binding receipt_sha digest api_arn api_sha worker_arn worker_sha identity_sha query_sha extra
  if ! summary=$(node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs" "$mode" \
    --receipt "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" \
    --expected-receipt-sha256 "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" \
    --application-sha "$LOCAL_SHA" \
    --active-api-task-definition-arn "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN" \
    --active-worker-task-definition-arn "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN" \
    --network-configuration-sha256 "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" \
    2>/dev/null); then
    error "The ClassPilot tile authorization rehearsal receipt is invalid, expired, used, or does not match the active baseline."
    return 1
  fi
  if ! binding=$(parse_classpilot_rehearsal_binding "$summary"); then
    error "The ClassPilot tile authorization rehearsal receipt binding was malformed."
    return 1
  fi
  IFS=$'\t' read -r receipt_sha digest api_arn api_sha worker_arn worker_sha identity_sha query_sha extra <<< "$binding"
  if [[ -n "$extra" ||
        "$receipt_sha" != "$EXPECTED_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL_SHA256" ]]; then
    error "The ClassPilot tile authorization rehearsal receipt does not match its out-of-band SHA-256."
    return 1
  fi
  TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256="$receipt_sha"
  DIGEST="$digest"
  API_ROLLOUT_TASK_DEF="$api_arn"
  TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256="$api_sha"
  WORKER_CANDIDATE_TASK_DEF="$worker_arn"
  TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256="$worker_sha"
  WORKER_NEW_REV="${worker_arn##*:}"
  TILE_AUTH_PLAN_REHEARSAL_IDENTITY_SHA256="$identity_sha"
  TILE_AUTH_PLAN_REHEARSAL_QUERY_IDENTIFIER_SHA256="$query_sha"
}

write_classpilot_rehearsal_receipt() {
  if [[ -z "${LOCALAPPDATA:-}" ]]; then
    error "LOCALAPPDATA is required for the ACL-restricted plan-gate rehearsal receipt."
    return 1
  fi
  local output_directory="${LOCALAPPDATA}/SchoolPilot/load-gates/tile-auth-rehearsals/${LOCAL_SHA}/$(date -u +%Y%m%dT%H%M%SZ)"
  local summary binding
  if ! summary=$(printf '%s\0%s' \
      "$TILE_AUTH_PLAN_PREFLIGHT_EVENTS_JSON" \
      "$TILE_AUTH_PLAN_PREDEPLOY_EVENTS_JSON" | node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs" write \
    --output "$output_directory" \
    --application-sha "$LOCAL_SHA" \
    --image-digest "$DIGEST" \
    --candidate-api-task-definition-arn "$API_ROLLOUT_TASK_DEF" \
    --candidate-api-task-definition-sha256 "$TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256" \
    --candidate-worker-task-definition-arn "$WORKER_CANDIDATE_TASK_DEF" \
    --candidate-worker-task-definition-sha256 "$TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256" \
    --active-api-task-definition-arn "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN" \
    --active-worker-task-definition-arn "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN" \
    --network-configuration-sha256 "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" \
    2>/dev/null); then
    error "The ACL-restricted ClassPilot tile authorization rehearsal receipt could not be sealed."
    return 1
  fi
  if ! binding=$(REHEARSAL_SUMMARY_JSON="$summary" node <<'NODE'
const value = JSON.parse(process.env.REHEARSAL_SUMMARY_JSON || "null");
if (value?.schemaVersion !== 1 ||
    value?.version !== "classpilot-tile-auth-plan-rehearsal-v1" ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^\d{4}-\d{2}-\d{2}T/.test(value.expiresAtUtc || "")) process.exit(1);
process.stdout.write(`${value.path}\t${value.sha256}\t${value.expiresAtUtc}`);
NODE
  ); then
    error "The sealed ClassPilot tile authorization rehearsal receipt summary was malformed."
    return 1
  fi
  local receipt_path receipt_sha expires_at extra
  IFS=$'\t' read -r receipt_path receipt_sha expires_at extra <<< "$binding"
  if [[ -z "$receipt_path" || -n "$extra" ]]; then
    error "The sealed ClassPilot tile authorization rehearsal receipt summary was ambiguous."
    return 1
  fi
  TILE_AUTH_PLAN_REHEARSAL_RECEIPT_PATH="$receipt_path"
  TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256="$receipt_sha"
  local inspected inspected_binding inspected_receipt inspected_digest
  local inspected_api inspected_api_sha inspected_worker inspected_worker_sha
  local inspected_identity inspected_query inspected_extra
  if ! inspected=$(node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-rehearsal-receipt.mjs" inspect \
    --receipt "$receipt_path" \
    --expected-receipt-sha256 "$receipt_sha" \
    --application-sha "$LOCAL_SHA" \
    --active-api-task-definition-arn "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN" \
    --active-worker-task-definition-arn "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN" \
    --network-configuration-sha256 "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" \
    2>/dev/null); then
    error "The sealed ClassPilot tile authorization rehearsal receipt failed independent inspection."
    return 1
  fi
  if ! inspected_binding=$(parse_classpilot_rehearsal_binding "$inspected"); then
    error "The independently inspected ClassPilot rehearsal receipt binding was malformed."
    return 1
  fi
  IFS=$'\t' read -r \
    inspected_receipt inspected_digest inspected_api inspected_api_sha \
    inspected_worker inspected_worker_sha inspected_identity inspected_query \
    inspected_extra <<< "$inspected_binding"
  if [[ -n "$inspected_extra" ||
        "$inspected_receipt" != "$receipt_sha" ||
        "$inspected_digest" != "$DIGEST" ||
        "$inspected_api" != "$API_ROLLOUT_TASK_DEF" ||
        "$inspected_api_sha" != "$TILE_AUTH_PLAN_REHEARSAL_API_TASK_DEFINITION_SHA256" ||
        "$inspected_worker" != "$WORKER_CANDIDATE_TASK_DEF" ||
        "$inspected_worker_sha" != "$TILE_AUTH_PLAN_REHEARSAL_WORKER_TASK_DEFINITION_SHA256" ||
        "$inspected_identity" != "$TILE_AUTH_PLAN_REHEARSAL_IDENTITY_SHA256" ||
        "$inspected_query" != "$TILE_AUTH_PLAN_REHEARSAL_QUERY_IDENTIFIER_SHA256" ]]; then
    error "The independently inspected ClassPilot rehearsal receipt drifted from the passing gate."
    return 1
  fi
  success "ClassPilot tile authorization candidate rehearsal passed (receipt=${receipt_path}, receiptSha256=${receipt_sha}, expiresAtUtc=${expires_at})"
}

cleanup_classpilot_tile_auth_plan_observation_controller_workspace() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT" ]]; then
    return 0
  fi
  if [[ -z "$TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT" ||
        "$TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT" != "${TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT}/controller" ]]; then
    error "The ClassPilot tile authorization observation controller workspace binding is invalid."
    return 1
  fi
  rm -f -- \
    "$TILE_AUTH_PLAN_OBSERVATION_TASK_PATH" \
    "$TILE_AUTH_PLAN_OBSERVATION_RESULT_PATH" \
    "$TILE_AUTH_PLAN_OBSERVATION_LOG_CONFIGURATION_PATH"
  if [[ -d "$TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT" ]]; then
    if ! rmdir -- "$TILE_AUTH_PLAN_OBSERVATION_CONTROLLER_ROOT"; then
      error "The ClassPilot tile authorization observation controller workspace retained unexpected files."
      return 1
    fi
  fi
  return 0
}

write_classpilot_tile_auth_plan_observation_packet_v2() {
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" != true ]]; then
    return 0
  fi
  if [[ -z "${LOCALAPPDATA:-}" ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_ID" =~ ^[a-z0-9][a-z0-9-]{7,127}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256" =~ ^[a-f0-9]{64}$ ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT" ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_PATH" ||
        ! "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" =~ ^[a-f0-9]{64}$ ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON" ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON" ||
        -z "$TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON" ]]; then
    error "The ClassPilot tile authorization observation finalization bindings are incomplete or malformed."
    return 1
  fi

  local finalization_json
  if ! finalization_json=$(
    OBSERVATION_COLLECTION_JSON="$TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON" \
    OBSERVATION_FINAL_NETWORK_JSON="$TILE_AUTH_PLAN_OBSERVATION_FINAL_NETWORK_JSON" \
    OBSERVATION_FINAL_POSTURE_JSON="$TILE_AUTH_PLAN_OBSERVATION_FINAL_POSTURE_JSON" \
    OBSERVATION_TASK_ARN="$TILE_AUTH_PLAN_OBSERVATION_TASK_ARN" \
    OBSERVATION_TASK_EXIT_CODE="$TILE_AUTH_PLAN_OBSERVATION_TASK_EXIT_CODE" \
    OBSERVATION_TASK_STATE="$TILE_AUTH_PLAN_OBSERVATION_TASK_STATE" \
    EXPECTED_REGION="$REGION" \
    EXPECTED_ACCOUNT_ID="$ACCOUNT_ID" node <<'NODE'
const collected = JSON.parse(process.env.OBSERVATION_COLLECTION_JSON || "null");
const finalNetwork = JSON.parse(process.env.OBSERVATION_FINAL_NETWORK_JSON || "null");
const finalProductionPosture = JSON.parse(
  process.env.OBSERVATION_FINAL_POSTURE_JSON || "null"
);
const taskArn = process.env.OBSERVATION_TASK_ARN || "";
const exitCodeText = process.env.OBSERVATION_TASK_EXIT_CODE || "";
const taskState = process.env.OBSERVATION_TASK_STATE || "";
let terminalTask = null;
if (taskArn) {
  const taskPattern = new RegExp(
    `^arn:aws:ecs:${process.env.EXPECTED_REGION}:${process.env.EXPECTED_ACCOUNT_ID}:task/(?:[^/]+/)?[a-f0-9]{32}$`
  );
  if (!taskPattern.test(taskArn)) {
    process.exit(1);
  }
  if (taskState === "exited" &&
      /^(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/.test(exitCodeText)) {
    terminalTask = {
      state: "exited",
      taskArn,
      exitCode: Number(exitCodeText),
    };
  } else if (taskState === "exit_unavailable" && exitCodeText === "") {
    terminalTask = {
      state: "exit_unavailable",
      taskArn,
      exitCode: null,
    };
  } else {
    process.exit(1);
  }
} else if (exitCodeText || taskState) {
  process.exit(1);
}
if (!collected || typeof collected !== "object" ||
    !Object.hasOwn(collected, "collection") ||
    !Object.hasOwn(collected, "eventsDocument")) {
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  createdAtUtc: new Date().toISOString(),
  terminalTask,
  collection: collected.collection,
  finalNetwork,
  finalProductionPosture,
  eventsDocument: collected.eventsDocument,
}));
NODE
  ); then
    error "The ClassPilot tile authorization observation finalization input could not be canonicalized."
    return 1
  fi

  local output_directory="${TILE_AUTH_PLAN_OBSERVATION_RUN_ROOT}/terminal"
  local identity_args=(
    --observation-id "$TILE_AUTH_PLAN_OBSERVATION_ID"
    --application-sha "$LOCAL_SHA"
    --image-digest "$DIGEST"
    --candidate-api-task-definition-arn "$API_ROLLOUT_TASK_DEF"
    --candidate-worker-task-definition-arn "$WORKER_CANDIDATE_TASK_DEF"
    --active-api-task-definition-arn "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN"
    --active-worker-task-definition-arn "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN"
    --initial-network-configuration-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_NETWORK_SHA256"
    --initial-production-posture-sha256 "$TILE_AUTH_PLAN_OBSERVATION_INITIAL_POSTURE_SHA256"
  )

  local write_summary write_binding packet_path packet_sha observation_id outcome
  local eligible_deploy eligible_diagnostic eligible_certification extra
  if ! write_summary=$(printf '%s' "$finalization_json" | node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation.mjs" write \
    --output "$output_directory" \
    --expected-attempt-sha256 "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" \
    "${identity_args[@]}" 2>/dev/null); then
    error "The ACL-restricted ClassPilot tile authorization observation-v2 packet could not be sealed."
    return 1
  fi
  if ! write_binding=$(CLASSPILOT_OBSERVATION_SUMMARY="$write_summary" node <<'NODE'
const value = JSON.parse(process.env.CLASSPILOT_OBSERVATION_SUMMARY || "null");
if (value?.schemaVersion !== 2 ||
    value?.version !== "classpilot-tile-auth-plan-observation-v2" ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.observationId || "") ||
    !["base_eligible", "base_ineligible", "task_failed", "evidence_unavailable"]
      .includes(value.observationOutcome) ||
    value.eligibleForDeployment !== false ||
    value.eligibleForDiagnostic !== false ||
    value.eligibleForCertification !== false) process.exit(1);
process.stdout.write([
  value.path,
  value.sha256,
  value.observationId,
  value.observationOutcome,
  String(value.eligibleForDeployment),
  String(value.eligibleForDiagnostic),
  String(value.eligibleForCertification),
].join("\t"));
NODE
  ); then
    error "The sealed ClassPilot tile authorization observation-v2 summary was malformed."
    return 1
  fi
  IFS=$'\t' read -r packet_path packet_sha observation_id outcome eligible_deploy eligible_diagnostic eligible_certification extra <<< "$write_binding"
  if [[ -z "$packet_path" || ! "$packet_sha" =~ ^[a-f0-9]{64}$ ||
        "$observation_id" != "$TILE_AUTH_PLAN_OBSERVATION_ID" ||
        "$eligible_deploy" != "false" || "$eligible_diagnostic" != "false" ||
        "$eligible_certification" != "false" || -n "$extra" ]]; then
    error "The sealed ClassPilot tile authorization observation-v2 summary was ambiguous."
    return 1
  fi

  local inspect_summary inspect_binding inspect_path inspect_sha inspect_id
  local inspect_outcome inspect_deploy inspect_diagnostic inspect_certification
  if ! inspect_summary=$(node \
    "$SCRIPT_DIR/manage-classpilot-tile-auth-plan-observation.mjs" inspect \
    --packet "$packet_path" \
    --expected-packet-sha256 "$packet_sha" \
    --expected-attempt-sha256 "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_SHA256" \
    "${identity_args[@]}" 2>/dev/null); then
    error "The sealed ClassPilot tile authorization observation-v2 packet failed independent inspection."
    return 1
  fi
  if ! inspect_binding=$(CLASSPILOT_OBSERVATION_SUMMARY="$inspect_summary" node <<'NODE'
const value = JSON.parse(process.env.CLASSPILOT_OBSERVATION_SUMMARY || "null");
if (value?.schemaVersion !== 2 ||
    value?.version !== "classpilot-tile-auth-plan-observation-v2" ||
    typeof value.path !== "string" || value.path.length === 0 ||
    !/^[a-f0-9]{64}$/.test(value.sha256 || "") ||
    !/^[a-z0-9][a-z0-9-]{7,127}$/.test(value.observationId || "") ||
    !["base_eligible", "base_ineligible", "task_failed", "evidence_unavailable"]
      .includes(value.observationOutcome) ||
    value.eligibleForDeployment !== false ||
    value.eligibleForDiagnostic !== false ||
    value.eligibleForCertification !== false) process.exit(1);
process.stdout.write([
  value.path,
  value.sha256,
  value.observationId,
  value.observationOutcome,
  String(value.eligibleForDeployment),
  String(value.eligibleForDiagnostic),
  String(value.eligibleForCertification),
].join("\t"));
NODE
  ); then
    error "The inspected ClassPilot tile authorization observation-v2 summary was malformed."
    return 1
  fi
  IFS=$'\t' read -r inspect_path inspect_sha inspect_id inspect_outcome inspect_deploy inspect_diagnostic inspect_certification extra <<< "$inspect_binding"
  if [[ "$inspect_path" != "$packet_path" || "$inspect_sha" != "$packet_sha" ||
        "$inspect_id" != "$observation_id" || "$inspect_outcome" != "$outcome" ||
        "$inspect_deploy" != "false" || "$inspect_diagnostic" != "false" ||
        "$inspect_certification" != "false" || -n "$extra" ]]; then
    error "The ClassPilot tile authorization observation-v2 packet changed between sealing and inspection."
    return 1
  fi

  if [[ "$outcome" == "base_eligible" ]] &&
     ! OBSERVATION_PACKET_PATH="$packet_path" \
       EXPECTED_PACKET_SHA256="$packet_sha" node <<'NODE'
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const packetPath = path.resolve(process.env.OBSERVATION_PACKET_PATH);
const packetBytes = fs.readFileSync(packetPath);
if (crypto.createHash("sha256").update(packetBytes).digest("hex") !==
    process.env.EXPECTED_PACKET_SHA256) process.exit(1);
const packet = JSON.parse(packetBytes.toString("utf8"));
if (packet?.schemaVersion !== 2 ||
    packet?.version !== "classpilot-tile-auth-plan-observation-v2" ||
    packet?.observationOutcome !== "base_eligible" ||
    packet?.preflightEvidenceFile !== "base-preflight.evidence.private.json" ||
    packet?.selectionEvidenceFile !== "base-selection.evidence.private.json") {
  process.exit(1);
}
const directory = path.dirname(packetPath);
function readCompanion(filename, expectedHash) {
  const bytes = fs.readFileSync(path.join(directory, filename));
  if (!/^[a-f0-9]{64}$/.test(expectedHash || "") ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    process.exit(1);
  }
  return JSON.parse(bytes.toString("utf8"));
}
const preflight = readCompanion(
  packet.preflightEvidenceFile,
  packet.preflightEvidenceSha256
);
const selection = readCompanion(
  packet.selectionEvidenceFile,
  packet.selectionEvidenceSha256
);
const preflightKeys = [
  "conflictingSessionPairs",
  "eligibleBases",
  "missingSessionPairs",
  "requiredSessionPairs",
  "reusedActiveSessionPairs",
  "status",
  "version",
].sort();
const selectionKeys = [
  "canonicalPrimaryOnlyGroups",
  "cohortSize",
  "eligibleSchools",
  "exactCohortGroups",
  "finalBases",
  "version",
].sort();
if (JSON.stringify(Object.keys(preflight).sort()) !==
      JSON.stringify(preflightKeys) ||
    preflight.version !== "classpilot-tile-auth-plan-base-preflight-v1" ||
    preflight.status !== "passed" ||
    preflight.eligibleBases !== 1 ||
    preflight.requiredSessionPairs !== 80 ||
    !Number.isInteger(preflight.reusedActiveSessionPairs) ||
    !Number.isInteger(preflight.missingSessionPairs) ||
    preflight.reusedActiveSessionPairs < 0 ||
    preflight.missingSessionPairs < 0 ||
    preflight.reusedActiveSessionPairs + preflight.missingSessionPairs !== 80 ||
    preflight.conflictingSessionPairs !== 0 ||
    JSON.stringify(Object.keys(selection).sort()) !==
      JSON.stringify(selectionKeys) ||
    selection.version !==
      "classpilot-tile-auth-plan-base-selection-v1" ||
    selection.cohortSize !== 40 ||
    selection.canonicalPrimaryOnlyGroups !== 19 ||
    selection.exactCohortGroups !== 19 ||
    selection.eligibleSchools !== 1 ||
    selection.finalBases !== 1) {
  process.exit(1);
}
NODE
  then
    error "The independently inspected ClassPilot tile authorization observation did not prove the exact 40/19/19/1/1 selection and 80-pair session posture."
    return 1
  fi

  TILE_AUTH_PLAN_OBSERVATION_PACKET_PATH="$packet_path"
  TILE_AUTH_PLAN_OBSERVATION_PACKET_SHA256="$packet_sha"
  TILE_AUTH_PLAN_OBSERVATION_OUTCOME="$outcome"
  success "ClassPilot tile authorization observation-v2 sealed (outcome=${outcome}, packet=${packet_path}, packetSha256=${packet_sha}, eligibleForDeployment=false, eligibleForDiagnostic=false, eligibleForCertification=false)"
  if [[ "$outcome" == "base_eligible" || "$outcome" == "base_ineligible" ]]; then
    return 0
  fi
  return 1
}

write_classpilot_tile_auth_plan_observation_packet_v1_disabled() {
  error "ClassPilot tile authorization observation-v1 is historical/inspect-only and cannot be written."
  return 1
}

launch_safe_active_api_preflight() {
  if [[ "$ACTIVATE_EMERGENCY" != true ]]; then
    return 0
  fi

  if [[ -z "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" ]]; then
    error "The launch-safe API preflight has no bound active task-definition reference."
    return 1
  fi

  local active_task_posture_json
  if ! active_task_posture_json=$(aws ecs describe-task-definition \
    --task-definition "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" \
    --query 'taskDefinition.{cpu:cpu,memory:memory,containers:containerDefinitions[?name==`api`].{name:name,memory:memory}}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager); then
    error "Could not read the active API task definition for the launch-safe 2048 MiB preflight."
    return 1
  fi

  if ! ACTIVE_TASK_POSTURE_JSON="$active_task_posture_json" node -e '
    const task = JSON.parse(process.env.ACTIVE_TASK_POSTURE_JSON || "null");
    const containers = Array.isArray(task?.containers) ? task.containers : [];
    const container = containers[0];
    const hardMemory = container?.memory;
    const hardMemoryNumber = Number(hardMemory);
    const hardMemoryInvalid = hardMemory !== undefined && hardMemory !== null &&
      (!Number.isFinite(hardMemoryNumber) || hardMemoryNumber < 2048);
    if (String(task?.cpu) !== "512" || String(task?.memory) !== "2048" ||
        containers.length !== 1 || hardMemoryInvalid) {
      process.exit(1);
    }
  '; then
    error "--activate-emergency requires the currently serving API to be exactly 512 CPU / 2048 MiB with no lower container hard-memory ceiling."
    return 1
  fi

  success "Active API launch-safe posture verified: ${PRODUCTION_PREFLIGHT_API_TASK_DEFINITION} (512 CPU / 2048 MiB)"
}

validate_capacity_acceptance_frontend_mode() {
  if [[ -z "$CAPACITY_ACCEPTANCE_FRONTEND_SHA" ]]; then
    return 0
  fi
  if [[ ! "$CAPACITY_ACCEPTANCE_FRONTEND_SHA" =~ ^[0-9a-f]{40}$ ||
        "$ENV" != "production" || "$DEPLOY_BACKEND" != false ||
        "$DEPLOY_FRONTEND" != true || "$CAPACITY_ACCEPTANCE_RELEASE" == true ||
        -n "$SAME_IMAGE_NETWORKING_STAGE" || -n "$IMAGE_TAG" || "$SKIP_WAIT" == true ]]; then
    error "The historical --capacity-acceptance-frontend-sha shape requires an exact lowercase 40-hex SHA and a production frontend-only deployment without --tag, --skip-wait, capacity-backend, or same-image flags; authorization is enforced separately."
    return 1
  fi
}

validate_retired_certification_admission_mode() {
  if [[ "$ENV" != "production" || "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    return 0
  fi
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ||
        -n "$CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION_REREAD" ||
        -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ]]; then
    error "The legacy observation/rehearsal/reread certification admission path is retired for production. Capacity acceptance is paused; historical evidence remains inspectable only."
    return 1
  fi
}

validate_same_image_networking_mode() {
  if [[ -z "$SAME_IMAGE_NETWORKING_STAGE" ]]; then
    if [[ -n "$EXPECTED_APP_SHA" || -n "$EXPECTED_IMAGE_DIGEST" ||
          -n "$EXPECTED_API_TASK_DEFINITION" || -n "$EXPECTED_WORKER_TASK_DEFINITION" ||
          -n "$EXPECTED_NETWORK_CONFIG_SHA256" ]]; then
      error "Expected application identity flags are valid only with --same-image-networking-stage."
      return 1
    fi
    return 0
  fi

  if [[ "$ENV" != "production" || "$DEPLOY_BACKEND" != true || "$DEPLOY_FRONTEND" != false ]]; then
    error "--same-image-networking-stage is allowed only for a production backend-only deployment."
    return 1
  fi
  if [[ "$SAME_IMAGE_NETWORKING_STAGE" != "PublicEcs" && "$SAME_IMAGE_NETWORKING_STAGE" != "NatRemoved" ]]; then
    error "--same-image-networking-stage must be exactly PublicEcs or NatRemoved."
    return 1
  fi
  if [[ "$ACTIVATE_EMERGENCY" == true || "$SKIP_WAIT" == true || -n "$IMAGE_TAG" ]]; then
    error "Same-image networking deployment rejects --activate-emergency, --skip-wait, and --tag."
    return 1
  fi
  if [[ ! "$EXPECTED_APP_SHA" =~ ^[0-9a-f]{40}$ ||
        ! "$EXPECTED_IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    error "Same-image networking deployment requires a full lowercase application SHA and image digest."
    return 1
  fi
  if [[ ! "$EXPECTED_NETWORK_CONFIG_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
    error "Same-image networking deployment requires --expected-network-config-sha256 with the exact 64-hex saved-plan validator network hash."
    return 1
  fi

  local api_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api(-emergency)?:[1-9][0-9]*$"
  local worker_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${WORKER_SERVICE}:[1-9][0-9]*$"
  if [[ ! "$EXPECTED_API_TASK_DEFINITION" =~ $api_pattern ||
        ! "$EXPECTED_WORKER_TASK_DEFINITION" =~ $worker_pattern ]]; then
    error "Same-image networking deployment requires exact full API and worker task-definition ARNs in the production account."
    return 1
  fi
}

same_image_application_identity_preflight() {
  local resolved_sha image_tag observed_digest
  if ! resolved_sha=$(git rev-parse --verify "${EXPECTED_APP_SHA}^{commit}" 2>/dev/null); then
    error "The expected deployed application SHA is not resolvable in this repository."
    return 1
  fi
  resolved_sha="${resolved_sha%$'\r'}"
  if [[ "$resolved_sha" != "$EXPECTED_APP_SHA" ]]; then
    error "The expected deployed application SHA did not resolve exactly."
    return 1
  fi

  image_tag="${EXPECTED_APP_SHA:0:12}"
  if ! observed_digest=$(aws ecr describe-images \
    --repository-name "${NAME}-api" \
    --image-ids "imageTag=${image_tag}" \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --region "$REGION" \
    --no-cli-pager); then
    error "Could not resolve the immutable digest for the expected application SHA tag."
    return 1
  fi
  observed_digest="${observed_digest%$'\r'}"
  if [[ "$observed_digest" != "$EXPECTED_IMAGE_DIGEST" ]]; then
    error "The expected application SHA tag and deployed image digest do not match."
    return 1
  fi
  success "Application identity bound: ${EXPECTED_APP_SHA} -> ${EXPECTED_IMAGE_DIGEST}"
}

same_image_autoscaling_contract_preflight() {
  local target_json
  if ! target_json=$(aws application-autoscaling describe-scalable-targets \
    --service-namespace ecs \
    --resource-ids "$AUTOSCALING_RESOURCE_ID" \
    --scalable-dimension "$AUTOSCALING_DIMENSION" \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not read the API scalable target for the same-image deployment."
    return 1
  fi
  if ! SAME_IMAGE_TARGET_JSON="$target_json" \
    EXPECTED_RESOURCE_ID="$AUTOSCALING_RESOURCE_ID" \
    EXPECTED_DIMENSION="$AUTOSCALING_DIMENSION" node <<'NODE'
const response = JSON.parse(process.env.SAME_IMAGE_TARGET_JSON || "null");
const targets = Array.isArray(response?.ScalableTargets) ? response.ScalableTargets : [];
const target = targets[0];
const suspended = target?.SuspendedState;
if (targets.length !== 1 || target?.ServiceNamespace !== "ecs" ||
    target?.ResourceId !== process.env.EXPECTED_RESOURCE_ID ||
    target?.ScalableDimension !== process.env.EXPECTED_DIMENSION ||
    ![1, 2].includes(Number(target?.MinCapacity)) || Number(target?.MaxCapacity) !== 8 ||
    typeof suspended?.DynamicScalingInSuspended !== "boolean" ||
    typeof suspended?.DynamicScalingOutSuspended !== "boolean" ||
    typeof suspended?.ScheduledScalingSuspended !== "boolean") {
  process.exit(1);
}
NODE
  then
    error "Same-image deployment requires one exact API scalable target at min 1/2, max 8, with an observable suspended state."
    return 1
  fi
}

same_image_service_contract_preflight() {
  local expected_api_ref="$1"
  local expected_worker_ref="$2"
  local phase="${3:-before same-image deployment}"
  local services_json network_hash
  rm -f .same-image-network-candidate.json
  if ! services_json=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" "$WORKER_SERVICE" \
    --query '{services:services[].{serviceName:serviceName,status:status,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,taskDefinition:taskDefinition,deployments:deployments[].{status:status,rolloutState:rolloutState,failedTasks:failedTasks,taskDefinition:taskDefinition},deploymentConfiguration:deploymentConfiguration,loadBalancers:loadBalancers,networkConfiguration:networkConfiguration},failures:failures}' \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not read the ECS service contract ${phase}."
    return 1
  fi

  if ! network_hash=$(SAME_IMAGE_SERVICES_JSON="$services_json" \
    EXPECTED_API_SERVICE="$SERVICE" \
    EXPECTED_WORKER_SERVICE="$WORKER_SERVICE" \
    EXPECTED_API_TASK_DEFINITION="$expected_api_ref" \
    EXPECTED_WORKER_TASK_DEFINITION="$expected_worker_ref" \
    SAME_IMAGE_NETWORK_PATH=".same-image-network-candidate.json" node <<'NODE'
const fs = require("fs");
const crypto = require("crypto");
const response = JSON.parse(process.env.SAME_IMAGE_SERVICES_JSON || "null");
const services = Array.isArray(response?.services) ? response.services : [];
if ((response?.failures || []).length !== 0 || services.length !== 2) process.exit(1);

const byName = (name) => services.filter((service) => service?.serviceName === name);
const apiMatches = byName(process.env.EXPECTED_API_SERVICE);
const workerMatches = byName(process.env.EXPECTED_WORKER_SERVICE);
if (apiMatches.length !== 1 || workerMatches.length !== 1) process.exit(1);

function normalizedNetwork(service) {
  const network = service?.networkConfiguration?.awsvpcConfiguration;
  const subnets = Array.isArray(network?.subnets) ? [...network.subnets].sort() : [];
  const securityGroups = Array.isArray(network?.securityGroups) ? [...network.securityGroups].sort() : [];
  if (subnets.length < 2 || new Set(subnets).size !== subnets.length ||
      securityGroups.length < 1 || new Set(securityGroups).size !== securityGroups.length ||
      network?.assignPublicIp !== "ENABLED") process.exit(1);
  return { subnets, securityGroups, assignPublicIp: "ENABLED" };
}

function assertService(service, expectedTask, desiredCounts, loadBalancerCount) {
  const deployments = Array.isArray(service?.deployments) ? service.deployments : [];
  const deployment = deployments[0];
  const configuration = service?.deploymentConfiguration;
  if (service?.status !== "ACTIVE" || !desiredCounts.includes(Number(service?.desiredCount)) ||
      Number(service?.runningCount) !== Number(service?.desiredCount) || Number(service?.pendingCount) !== 0 ||
      service?.taskDefinition !== expectedTask || deployments.length !== 1 ||
      deployment?.status !== "PRIMARY" || deployment?.rolloutState !== "COMPLETED" ||
      deployment?.taskDefinition !== expectedTask || !Object.hasOwn(deployment || {}, "failedTasks") ||
      Number(deployment?.failedTasks) !== 0 ||
      Number(configuration?.minimumHealthyPercent) !== 100 || Number(configuration?.maximumPercent) !== 200 ||
      configuration?.deploymentCircuitBreaker?.enable !== true ||
      configuration?.deploymentCircuitBreaker?.rollback !== true || configuration?.strategy !== "ROLLING" ||
      (service?.loadBalancers || []).length !== loadBalancerCount) process.exit(1);
}

const api = apiMatches[0];
const worker = workerMatches[0];
assertService(api, process.env.EXPECTED_API_TASK_DEFINITION, [1, 2], 1);
assertService(worker, process.env.EXPECTED_WORKER_TASK_DEFINITION, [1], 0);
const apiNetwork = normalizedNetwork(api);
const workerNetwork = normalizedNetwork(worker);
if (JSON.stringify(apiNetwork) !== JSON.stringify(workerNetwork)) process.exit(1);
const payload = { awsvpcConfiguration: apiNetwork };
const canonical = JSON.stringify(payload);
fs.writeFileSync(process.env.SAME_IMAGE_NETWORK_PATH, canonical);
process.stdout.write(crypto.createHash("sha256").update(canonical).digest("hex"));
NODE
  ); then
    error "ECS services violated exact identity, public-network, deployment-policy, or stability requirements ${phase}."
    return 1
  fi
  if [[ -n "$SAME_IMAGE_BOUND_NETWORK_HASH" && "$network_hash" != "$SAME_IMAGE_BOUND_NETWORK_HASH" ]]; then
    rm -f .same-image-network-candidate.json
    error "ECS network configuration drifted after its initial same-image binding ${phase}."
    return 1
  fi
  if [[ "$network_hash" != "$EXPECTED_NETWORK_CONFIG_SHA256" ]]; then
    rm -f .same-image-network-candidate.json
    error "Observed ECS network configuration does not match the attested expected SHA-256 ${phase}."
    return 1
  fi
  if [[ -z "$SAME_IMAGE_BOUND_NETWORK_HASH" ]]; then
    SAME_IMAGE_BOUND_NETWORK_HASH="$network_hash"
    if ! mv -f .same-image-network-candidate.json .same-image-network.json; then
      error "Could not bind the initial same-image network configuration."
      return 1
    fi
  else
    rm -f .same-image-network-candidate.json
  fi
  SAME_IMAGE_NETWORK_HASH="$SAME_IMAGE_BOUND_NETWORK_HASH"
  success "Same-image ECS contract verified ${phase}; bound network sha256=${SAME_IMAGE_NETWORK_HASH}"
}

same_image_runtime_task_network_preflight() {
  local expected_api_ref="$1"
  local expected_worker_ref="$2"
  local phase="${3:-during same-image deployment}"
  local services_json api_list_json worker_list_json task_arns_text tasks_json eni_ids_text
  local network_interfaces_json target_group_arn target_group_json target_health_json
  local task_arns=() eni_ids=() value

  if ! services_json=$(aws ecs describe-services \
    --cluster "$CLUSTER" \
    --services "$SERVICE" "$WORKER_SERVICE" \
    --query '{services:services[].{serviceName:serviceName,status:status,desiredCount:desiredCount,runningCount:runningCount,pendingCount:pendingCount,taskDefinition:taskDefinition,loadBalancers:loadBalancers,networkConfiguration:networkConfiguration},failures:failures}' \
    --output json --region "$REGION" --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not read service state for the exact running-task network proof ${phase}."
    return 1
  fi
  if ! api_list_json=$(aws ecs list-tasks \
    --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING \
    --query '{taskArns:taskArns}' --output json --region "$REGION" \
    --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not list every running API task ${phase}."
    return 1
  fi
  if ! worker_list_json=$(aws ecs list-tasks \
    --cluster "$CLUSTER" --service-name "$WORKER_SERVICE" --desired-status RUNNING \
    --query '{taskArns:taskArns}' --output json --region "$REGION" \
    --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not list every running worker task ${phase}."
    return 1
  fi
  if ! task_arns_text=$(SAME_IMAGE_SERVICES_JSON="$services_json" \
    SAME_IMAGE_API_TASKS_JSON="$api_list_json" SAME_IMAGE_WORKER_TASKS_JSON="$worker_list_json" \
    EXPECTED_API_SERVICE="$SERVICE" EXPECTED_WORKER_SERVICE="$WORKER_SERVICE" \
    EXPECTED_API_TASK_DEFINITION="$expected_api_ref" EXPECTED_WORKER_TASK_DEFINITION="$expected_worker_ref" node <<'NODE'
const servicesResponse = JSON.parse(process.env.SAME_IMAGE_SERVICES_JSON || "null");
const apiList = JSON.parse(process.env.SAME_IMAGE_API_TASKS_JSON || "null");
const workerList = JSON.parse(process.env.SAME_IMAGE_WORKER_TASKS_JSON || "null");
const services = Array.isArray(servicesResponse?.services) ? servicesResponse.services : [];
if ((servicesResponse?.failures || []).length !== 0 || services.length !== 2) process.exit(1);
function oneService(name, expectedTask) {
  const matches = services.filter((service) => service?.serviceName === name);
  if (matches.length !== 1) process.exit(1);
  const service = matches[0];
  if (service?.status !== "ACTIVE" || Number(service?.desiredCount) < 1 ||
      Number(service?.runningCount) !== Number(service?.desiredCount) || Number(service?.pendingCount) !== 0 ||
      service?.taskDefinition !== expectedTask) process.exit(1);
  return service;
}
const api = oneService(process.env.EXPECTED_API_SERVICE, process.env.EXPECTED_API_TASK_DEFINITION);
const worker = oneService(process.env.EXPECTED_WORKER_SERVICE, process.env.EXPECTED_WORKER_TASK_DEFINITION);
const apiTasks = Array.isArray(apiList?.taskArns) ? apiList.taskArns : [];
const workerTasks = Array.isArray(workerList?.taskArns) ? workerList.taskArns : [];
const all = [...apiTasks, ...workerTasks];
if (apiTasks.length !== Number(api.desiredCount) || workerTasks.length !== Number(worker.desiredCount) ||
    all.length < 2 || new Set(all).size !== all.length || all.some((arn) => typeof arn !== "string" || !arn.startsWith("arn:aws:ecs:"))) {
  process.exit(1);
}
process.stdout.write(all.join("\n"));
NODE
  ); then
    error "Running task enumeration did not exactly match stable API and worker desired counts ${phase}."
    return 1
  fi
  while IFS= read -r value; do [[ -n "$value" ]] && task_arns+=("$value"); done <<< "$task_arns_text"
  if [[ "${#task_arns[@]}" -lt 2 ]]; then
    error "Running task enumeration was empty or incomplete ${phase}."
    return 1
  fi

  if ! tasks_json=$(aws ecs describe-tasks \
    --cluster "$CLUSTER" --tasks "${task_arns[@]}" \
    --query '{tasks:tasks[].{taskArn:taskArn,taskDefinitionArn:taskDefinitionArn,lastStatus:lastStatus,group:group,attachments:attachments},failures:failures}' \
    --output json --region "$REGION" --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not describe every enumerated running task ${phase}."
    return 1
  fi
  if ! eni_ids_text=$(SAME_IMAGE_TASKS_JSON="$tasks_json" \
    SAME_IMAGE_API_TASKS_JSON="$api_list_json" SAME_IMAGE_WORKER_TASKS_JSON="$worker_list_json" \
    EXPECTED_API_SERVICE="$SERVICE" EXPECTED_WORKER_SERVICE="$WORKER_SERVICE" \
    EXPECTED_API_TASK_DEFINITION="$expected_api_ref" EXPECTED_WORKER_TASK_DEFINITION="$expected_worker_ref" node <<'NODE'
const response = JSON.parse(process.env.SAME_IMAGE_TASKS_JSON || "null");
const apiArns = JSON.parse(process.env.SAME_IMAGE_API_TASKS_JSON || "null")?.taskArns || [];
const workerArns = JSON.parse(process.env.SAME_IMAGE_WORKER_TASKS_JSON || "null")?.taskArns || [];
const expectedArns = [...apiArns, ...workerArns];
const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
if ((response?.failures || []).length !== 0 || tasks.length !== expectedArns.length ||
    JSON.stringify(tasks.map((task) => task?.taskArn).sort()) !== JSON.stringify([...expectedArns].sort())) process.exit(1);
const apiSet = new Set(apiArns); const workerSet = new Set(workerArns); const enis = [];
for (const task of tasks) {
  const isApi = apiSet.has(task.taskArn); const isWorker = workerSet.has(task.taskArn);
  const expectedTask = isApi ? process.env.EXPECTED_API_TASK_DEFINITION : process.env.EXPECTED_WORKER_TASK_DEFINITION;
  const expectedGroup = `service:${isApi ? process.env.EXPECTED_API_SERVICE : process.env.EXPECTED_WORKER_SERVICE}`;
  if (isApi === isWorker || task?.lastStatus !== "RUNNING" || task?.taskDefinitionArn !== expectedTask || task?.group !== expectedGroup) process.exit(1);
  const attachments = (task?.attachments || []).filter((attachment) => attachment?.type === "ElasticNetworkInterface");
  const ids = attachments.flatMap((attachment) => (attachment?.details || []))
    .filter((detail) => detail?.name === "networkInterfaceId").map((detail) => detail?.value).filter(Boolean);
  if (attachments.length !== 1 || ids.length !== 1 || !/^eni-[A-Za-z0-9]+$/.test(ids[0])) process.exit(1);
  enis.push(ids[0]);
}
if (new Set(enis).size !== enis.length) process.exit(1);
process.stdout.write(enis.join("\n"));
NODE
  ); then
    error "Running task revisions, service ownership, or ENI attachments were mixed or incomplete ${phase}."
    return 1
  fi
  while IFS= read -r value; do [[ -n "$value" ]] && eni_ids+=("$value"); done <<< "$eni_ids_text"
  if [[ "${#eni_ids[@]}" -ne "${#task_arns[@]}" ]]; then
    error "Every running task must bind to exactly one unique ENI ${phase}."
    return 1
  fi
  if ! network_interfaces_json=$(aws ec2 describe-network-interfaces \
    --network-interface-ids "${eni_ids[@]}" \
    --query '{NetworkInterfaces:NetworkInterfaces[].{NetworkInterfaceId:NetworkInterfaceId,Status:Status,SubnetId:SubnetId,Groups:Groups[].{GroupId:GroupId},Association:Association,PrivateIpAddress:PrivateIpAddress}}' \
    --output json --region "$REGION" --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not describe every running task ENI ${phase}."
    return 1
  fi
  if ! target_group_arn=$(SAME_IMAGE_SERVICES_JSON="$services_json" EXPECTED_API_SERVICE="$SERVICE" node <<'NODE'
const response=JSON.parse(process.env.SAME_IMAGE_SERVICES_JSON||"null");
const matches=(response?.services||[]).filter((service)=>service?.serviceName===process.env.EXPECTED_API_SERVICE);
const balancers=matches[0]?.loadBalancers||[];
if(matches.length!==1||balancers.length!==1||typeof balancers[0]?.targetGroupArn!=="string")process.exit(1);
process.stdout.write(balancers[0].targetGroupArn);
NODE
  ); then
    error "Could not bind the API service to exactly one target group ${phase}."
    return 1
  fi
  if ! target_group_json=$(aws elbv2 describe-target-groups \
    --target-group-arns "$target_group_arn" \
    --query '{TargetGroups:TargetGroups[].{TargetGroupArn:TargetGroupArn,Port:Port,TargetType:TargetType}}' \
    --output json --region "$REGION" --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not describe the API target group ${phase}."
    return 1
  fi
  if ! target_health_json=$(aws elbv2 describe-target-health \
    --target-group-arn "$target_group_arn" \
    --query '{TargetHealthDescriptions:TargetHealthDescriptions[].{Target:Target,TargetHealth:TargetHealth}}' \
    --output json --region "$REGION" --cli-connect-timeout 3 --cli-read-timeout 5 --no-cli-pager); then
    error "Could not describe every API target ${phase}."
    return 1
  fi

  if ! SAME_IMAGE_NETWORK_PATH=".same-image-network.json" SAME_IMAGE_TASKS_JSON="$tasks_json" \
    SAME_IMAGE_API_TASKS_JSON="$api_list_json" SAME_IMAGE_ENIS_JSON="$network_interfaces_json" \
    SAME_IMAGE_TARGET_GROUP_JSON="$target_group_json" SAME_IMAGE_TARGET_HEALTH_JSON="$target_health_json" \
    SAME_IMAGE_TARGET_GROUP_ARN="$target_group_arn" node <<'NODE'
const fs=require("fs"); const net=require("net");
const network=JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_NETWORK_PATH,"utf8"))?.awsvpcConfiguration;
const taskResponse=JSON.parse(process.env.SAME_IMAGE_TASKS_JSON||"null");
const apiArns=new Set(JSON.parse(process.env.SAME_IMAGE_API_TASKS_JSON||"null")?.taskArns||[]);
const eniResponse=JSON.parse(process.env.SAME_IMAGE_ENIS_JSON||"null");
const targetGroupResponse=JSON.parse(process.env.SAME_IMAGE_TARGET_GROUP_JSON||"null");
const healthResponse=JSON.parse(process.env.SAME_IMAGE_TARGET_HEALTH_JSON||"null");
const tasks=taskResponse?.tasks||[]; const enis=eniResponse?.NetworkInterfaces||[];
const expectedSubnets=[...(network?.subnets||[])].sort(); const expectedGroups=[...(network?.securityGroups||[])].sort();
const expectedEniIds=[]; const taskByEni=new Map();
for(const task of tasks){
  const id=(task?.attachments||[]).flatMap((a)=>a?.details||[]).find((d)=>d?.name==="networkInterfaceId")?.value;
  if(!id||taskByEni.has(id))process.exit(1); expectedEniIds.push(id); taskByEni.set(id,task);
}
if(expectedSubnets.length<2||expectedGroups.length<1||network?.assignPublicIp!=="ENABLED"||
   enis.length!==expectedEniIds.length||JSON.stringify(enis.map((eni)=>eni?.NetworkInterfaceId).sort())!==JSON.stringify(expectedEniIds.sort()))process.exit(1);
const apiPrivateIps=[]; const publicIps=[];
for(const eni of enis){
  const groups=(eni?.Groups||[]).map((group)=>group?.GroupId).sort(); const publicIp=eni?.Association?.PublicIp;
  if(eni?.Status!=="in-use"||!expectedSubnets.includes(eni?.SubnetId)||JSON.stringify(groups)!==JSON.stringify(expectedGroups)||
     net.isIP(eni?.PrivateIpAddress||"")!==4||net.isIP(publicIp||"")!==4)process.exit(1);
  publicIps.push(publicIp);
  if(apiArns.has(taskByEni.get(eni.NetworkInterfaceId)?.taskArn))apiPrivateIps.push(eni.PrivateIpAddress);
}
if(new Set(publicIps).size!==publicIps.length||new Set(apiPrivateIps).size!==apiPrivateIps.length||apiPrivateIps.length!==apiArns.size)process.exit(1);
const groups=targetGroupResponse?.TargetGroups||[]; const group=groups[0]; const targets=healthResponse?.TargetHealthDescriptions||[];
if(groups.length!==1||group?.TargetGroupArn!==process.env.SAME_IMAGE_TARGET_GROUP_ARN||group?.TargetType!=="ip"||
   !Number.isInteger(Number(group?.Port))||Number(group.Port)<1||targets.length!==apiPrivateIps.length||
   JSON.stringify(targets.map((entry)=>entry?.Target?.Id).sort())!==JSON.stringify([...apiPrivateIps].sort())||
   targets.some((entry)=>Number(entry?.Target?.Port)!==Number(group.Port)||entry?.TargetHealth?.State!=="healthy"))process.exit(1);
NODE
  then
    error "Running task ENIs, public IPv4 egress, security groups, subnets, or ALB targets failed exact verification ${phase}."
    return 1
  fi
  success "Every running API/worker task, ENI, public IPv4, and healthy API target was verified ${phase}"
}

same_image_nat_posture_preflight() {
  local subnet_ids=() subnet_id subnets_json vpc_id route_tables_json internet_gateways_json nat_json
  while IFS= read -r subnet_id; do
    [[ -n "$subnet_id" ]] && subnet_ids+=("$subnet_id")
  done < <(node -e '
    const fs = require("fs");
    const network = JSON.parse(fs.readFileSync(".same-image-network.json", "utf8"));
    for (const subnet of network?.awsvpcConfiguration?.subnets || []) console.log(subnet);
  ')
  if [[ "${#subnet_ids[@]}" -lt 2 ]]; then
    error "Same-image NAT posture could not bind the ECS public subnet set."
    return 1
  fi
  if ! subnets_json=$(aws ec2 describe-subnets \
    --subnet-ids "${subnet_ids[@]}" \
    --query '{Subnets:Subnets[].{SubnetId:SubnetId,VpcId:VpcId,State:State}}' \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not resolve the VPC for the same-image ECS subnet set."
    return 1
  fi
  if ! vpc_id=$(SAME_IMAGE_SUBNETS_JSON="$subnets_json" \
    SAME_IMAGE_NETWORK_PATH=".same-image-network.json" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(process.env.SAME_IMAGE_SUBNETS_JSON || "null");
const subnets = Array.isArray(response?.Subnets) ? response.Subnets : [];
const network = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_NETWORK_PATH, "utf8"));
const expectedSubnetIds = [...(network?.awsvpcConfiguration?.subnets || [])].sort();
const actualSubnetIds = subnets.map((subnet) => subnet?.SubnetId).sort();
const vpcs = new Set(subnets.map((subnet) => subnet?.VpcId));
if (expectedSubnetIds.length < 2 || JSON.stringify(actualSubnetIds) !== JSON.stringify(expectedSubnetIds) || vpcs.size !== 1 ||
    [...vpcs][0] === undefined || subnets.some((subnet) => subnet?.State !== "available")) process.exit(1);
process.stdout.write([...vpcs][0]);
NODE
  ); then
    error "The ECS subnet set is incomplete, unavailable, or spans multiple VPCs."
    return 1
  fi
  if ! nat_json=$(aws ec2 describe-nat-gateways \
    --filter "Name=vpc-id,Values=${vpc_id}" \
    --query '{NatGateways:NatGateways[].{NatGatewayId:NatGatewayId,State:State}}' \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not observe the live NAT posture for ${SAME_IMAGE_NETWORKING_STAGE}."
    return 1
  fi
  if ! route_tables_json=$(aws ec2 describe-route-tables \
    --filters "Name=vpc-id,Values=${vpc_id}" \
    --query '{RouteTables:RouteTables[].{RouteTableId:RouteTableId,Associations:Associations[].{Main:Main,SubnetId:SubnetId},Routes:Routes[].{DestinationCidrBlock:DestinationCidrBlock,GatewayId:GatewayId,NatGatewayId:NatGatewayId,State:State}}}' \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not observe effective route tables for the same-image ECS subnet set."
    return 1
  fi
  if ! internet_gateways_json=$(aws ec2 describe-internet-gateways \
    --filters "Name=attachment.vpc-id,Values=${vpc_id}" \
    --query '{InternetGateways:InternetGateways[].{InternetGatewayId:InternetGatewayId,Attachments:Attachments[].{VpcId:VpcId,State:State}}}' \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 3 \
    --cli-read-timeout 5 \
    --no-cli-pager); then
    error "Could not observe the internet gateway for the same-image ECS VPC."
    return 1
  fi
  if ! SAME_IMAGE_ROUTE_TABLES_JSON="$route_tables_json" \
    SAME_IMAGE_INTERNET_GATEWAYS_JSON="$internet_gateways_json" \
    SAME_IMAGE_VPC_ID="$vpc_id" node <<'NODE'
const fs = require("fs");
const network = JSON.parse(fs.readFileSync(".same-image-network.json", "utf8"));
const subnets = network?.awsvpcConfiguration?.subnets || [];
const routeResponse = JSON.parse(process.env.SAME_IMAGE_ROUTE_TABLES_JSON || "null");
const gatewayResponse = JSON.parse(process.env.SAME_IMAGE_INTERNET_GATEWAYS_JSON || "null");
const routeTables = Array.isArray(routeResponse?.RouteTables) ? routeResponse.RouteTables : [];
const gateways = Array.isArray(gatewayResponse?.InternetGateways) ? gatewayResponse.InternetGateways : [];
const vpcId = process.env.SAME_IMAGE_VPC_ID;
if (subnets.length < 2 || routeTables.length < 1 || gateways.length !== 1) process.exit(1);
const gateway = gateways[0];
const attachments = Array.isArray(gateway?.Attachments) ? gateway.Attachments : [];
if (!/^igw-[A-Za-z0-9]+$/.test(gateway?.InternetGatewayId || "") || attachments.length !== 1 ||
    attachments[0]?.VpcId !== vpcId || attachments[0]?.State !== "available") process.exit(1);
const mainTables = routeTables.filter((table) =>
  (table?.Associations || []).some((association) => association?.Main === true)
);
if (mainTables.length !== 1) process.exit(1);
for (const subnetId of subnets) {
  const explicit = routeTables.filter((table) =>
    (table?.Associations || []).some((association) => association?.SubnetId === subnetId)
  );
  if (explicit.length > 1) process.exit(1);
  const effective = explicit[0] || mainTables[0];
  const defaults = (effective?.Routes || []).filter((route) => route?.DestinationCidrBlock === "0.0.0.0/0");
  if (defaults.length !== 1 || defaults[0]?.State !== "active" ||
      defaults[0]?.GatewayId !== gateway.InternetGatewayId) process.exit(1);
}
NODE
  then
    error "Each ECS subnet must resolve through one active IPv4 default route to the VPC's attached internet gateway."
    return 1
  fi
  if ! SAME_IMAGE_NAT_JSON="$nat_json" SAME_IMAGE_STAGE="$SAME_IMAGE_NETWORKING_STAGE" node <<'NODE'
const response = JSON.parse(process.env.SAME_IMAGE_NAT_JSON || "null");
const gateways = Array.isArray(response?.NatGateways) ? response.NatGateways : [];
const live = gateways.filter((gateway) => gateway?.State !== "deleted");
if (process.env.SAME_IMAGE_STAGE === "PublicEcs") {
  if (live.length !== 2 || live.some((gateway) => gateway?.State !== "available")) process.exit(1);
} else if (process.env.SAME_IMAGE_STAGE === "NatRemoved") {
  if (live.length !== 0) process.exit(1);
} else {
  process.exit(1);
}
NODE
  then
    error "Live NAT posture does not match ${SAME_IMAGE_NETWORKING_STAGE} (PublicEcs=two available; NatRemoved=zero)."
    return 1
  fi
  success "Live NAT posture verified for ${SAME_IMAGE_NETWORKING_STAGE} in ${vpc_id}"
}

render_same_image_clone_request() {
  local label="$1"
  local source_arn="$2"
  local container_name="$3"
  local source_path=".same-image-${label}-source.json"
  local request_path=".same-image-${label}-request.json"

  if ! aws ecs describe-task-definition \
    --task-definition "$source_arn" \
    --include TAGS \
    --output json \
    --region "$REGION" \
    --no-cli-pager > "$source_path"; then
    error "Could not read the exact ${label} task definition for same-image cloning."
    return 1
  fi

  if ! SAME_IMAGE_SOURCE_PATH="$source_path" \
    SAME_IMAGE_REQUEST_PATH="$request_path" \
    EXPECTED_SOURCE_ARN="$source_arn" \
    EXPECTED_CONTAINER_NAME="$container_name" \
    EXPECTED_IMAGE_REF="${ECR_REPO}@${EXPECTED_IMAGE_DIGEST}" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_SOURCE_PATH, "utf8"));
const task = response?.taskDefinition;
const requestFields = [
  "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
  "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
  "runtimePlatform", "ephemeralStorage", "proxyConfiguration", "inferenceAccelerators",
  "pidMode", "ipcMode", "enableFaultInjection"
];
const readOnlyFields = new Set([
  "taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
  "registeredAt", "registeredBy", "deregisteredAt"
]);
if (!task || task.taskDefinitionArn !== process.env.EXPECTED_SOURCE_ARN || task.status !== "ACTIVE") {
  process.exit(1);
}
for (const key of Object.keys(task)) {
  if (!requestFields.includes(key) && !readOnlyFields.has(key)) process.exit(1);
}
const containers = Array.isArray(task.containerDefinitions) ? task.containerDefinitions : [];
const primary = containers.filter((container) => container?.name === process.env.EXPECTED_CONTAINER_NAME);
if (containers.length < 1 || primary.length !== 1 || primary[0].image !== process.env.EXPECTED_IMAGE_REF) {
  process.exit(1);
}
if (containers.some((container) => typeof container?.image !== "string" ||
    !/@sha256:[0-9a-f]{64}$/.test(container.image))) {
  process.exit(1);
}
const request = {};
for (const key of requestFields) {
  if (Object.hasOwn(task, key) && task[key] !== null) request[key] = task[key];
}
if (!request.family || !Array.isArray(request.containerDefinitions)) process.exit(1);
const tags = Array.isArray(response.tags) ? response.tags : [];
if (tags.length > 0) request.tags = tags;
fs.writeFileSync(process.env.SAME_IMAGE_REQUEST_PATH, JSON.stringify(request));
NODE
  then
    error "The ${label} task definition is mutable, mismatched, or cannot be cloned exactly."
    return 1
  fi
}

register_same_image_clone_request() {
  local label="$1"
  local source_arn="$2"
  local container_name="$3"
  local request_path=".same-image-${label}-request.json"
  local registration_path=".same-image-${label}-registration.json"
  local registered_path=".same-image-${label}-registered.json"
  local registered_arn

  if ! aws ecs register-task-definition \
    --cli-input-json "file://${request_path}" \
    --output json \
    --region "$REGION" \
    --no-cli-pager > "$registration_path"; then
    error "Could not register the exact same-image ${label} task-definition clone."
    return 1
  fi
  if ! registered_arn=$(SAME_IMAGE_REGISTRATION_PATH="$registration_path" \
    EXPECTED_SOURCE_ARN="$source_arn" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_REGISTRATION_PATH, "utf8"));
const source = process.env.EXPECTED_SOURCE_ARN;
const arn = response?.taskDefinition?.taskDefinitionArn;
const familyPrefix = source.replace(/:[1-9][0-9]*$/, ":");
if (typeof arn !== "string" || arn === source || !arn.startsWith(familyPrefix) || !/:[1-9][0-9]*$/.test(arn)) {
  process.exit(1);
}
process.stdout.write(arn);
NODE
  ); then
    error "ECS returned an invalid same-image ${label} task-definition identity."
    return 1
  fi

  if ! aws ecs describe-task-definition \
    --task-definition "$registered_arn" \
    --include TAGS \
    --output json \
    --region "$REGION" \
    --no-cli-pager > "$registered_path"; then
    error "Could not verify the registered same-image ${label} task definition."
    return 1
  fi

  if ! SAME_IMAGE_REQUEST_PATH="$request_path" \
    SAME_IMAGE_REGISTERED_PATH="$registered_path" \
    EXPECTED_REGISTERED_ARN="$registered_arn" \
    EXPECTED_CONTAINER_NAME="$container_name" \
    EXPECTED_IMAGE_REF="${ECR_REPO}@${EXPECTED_IMAGE_DIGEST}" node <<'NODE'
const fs = require("fs");
const expected = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_REQUEST_PATH, "utf8"));
const response = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_REGISTERED_PATH, "utf8"));
const task = response?.taskDefinition;
const fields = [
  "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
  "volumes", "placementConstraints", "requiresCompatibilities", "cpu", "memory",
  "runtimePlatform", "ephemeralStorage", "proxyConfiguration", "inferenceAccelerators",
  "pidMode", "ipcMode", "enableFaultInjection"
];
if (!task || task.taskDefinitionArn !== process.env.EXPECTED_REGISTERED_ARN || task.status !== "ACTIVE") {
  process.exit(1);
}
const actual = {};
for (const key of fields) {
  if (Object.hasOwn(task, key) && task[key] !== null) actual[key] = task[key];
}
if (Array.isArray(response.tags) && response.tags.length > 0) actual.tags = response.tags;
function canonical(value, key = "") {
  if (Array.isArray(value)) {
    const values = value.map((item) => canonical(item));
    if (key === "tags") values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return values;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((name) => [name, canonical(value[name], name)]));
  }
  return value;
}
if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) process.exit(1);
const containers = Array.isArray(task.containerDefinitions) ? task.containerDefinitions : [];
const primary = containers.filter((container) => container?.name === process.env.EXPECTED_CONTAINER_NAME);
if (primary.length !== 1 || primary[0].image !== process.env.EXPECTED_IMAGE_REF ||
    containers.some((container) => !/@sha256:[0-9a-f]{64}$/.test(container?.image || ""))) {
  process.exit(1);
}
NODE
  then
    error "The registered ${label} revision is not an exact digest-preserving clone."
    return 1
  fi

  if [[ "$label" == "api" ]]; then
    SAME_IMAGE_API_TASK_DEFINITION="$registered_arn"
  else
    SAME_IMAGE_WORKER_TASK_DEFINITION="$registered_arn"
  fi
  success "Registered exact same-image ${label} clone: ${registered_arn}"
}

run_same_image_migration_task() {
  local migration_task_arn migration_wait_result
  info "Running startup migrations with exact same-image API revision ${SAME_IMAGE_API_TASK_DEFINITION}..."
  aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$SAME_IMAGE_API_TASK_DEFINITION" \
    --network-configuration "file://.same-image-network.json" \
    --overrides '{"containerOverrides":[{"name":"api","environment":[{"name":"RUN_MIGRATIONS_ONLY","value":"true"},{"name":"SCHEDULER_ENABLED","value":"false"}]}]}' \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .migration-task.json

  if ! migration_task_arn=$(node -e '
    const fs = require("fs");
    const response = JSON.parse(fs.readFileSync(".migration-task.json", "utf8"));
    if ((response.failures || []).length !== 0 || !response.tasks?.[0]?.taskArn || response.tasks.length !== 1) process.exit(1);
    process.stdout.write(response.tasks[0].taskArn);
  '); then
    error "The same-image migration task was not started exactly once."
    return 1
  fi

  set +e
  wait_for_migration_task_stopped "$migration_task_arn"
  migration_wait_result=$?
  set -e
  aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$migration_task_arn" \
    --output json \
    --region "$REGION" \
    --no-cli-pager > .migration-result.json

  if [[ "$migration_wait_result" -eq 124 ]]; then
    error "Same-image migration exceeded the one-hour controller deadline and was stopped; no service rollout was attempted."
    return 1
  elif [[ "$migration_wait_result" -eq 125 ]]; then
    error "Same-image migration stop could not be confirmed within the bounded five-minute stop-observation window; no service rollout was attempted."
    return 1
  elif [[ "$migration_wait_result" -ne 0 ]]; then
    error "Same-image migration observation failed; no service rollout was attempted."
    return 1
  fi
  if ! SAME_IMAGE_MIGRATION_RESULT_PATH=".migration-result.json" \
    EXPECTED_MIGRATION_TASK_ARN="$migration_task_arn" node <<'NODE'
const fs = require("fs");
const response = JSON.parse(fs.readFileSync(process.env.SAME_IMAGE_MIGRATION_RESULT_PATH, "utf8"));
const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
const task = tasks[0];
const containers = Array.isArray(task?.containers) ? task.containers.filter((container) => container?.name === "api") : [];
if ((response?.failures || []).length !== 0 || tasks.length !== 1 ||
    task?.taskArn !== process.env.EXPECTED_MIGRATION_TASK_ARN || task?.lastStatus !== "STOPPED" ||
    containers.length !== 1 || Number(containers[0]?.exitCode) !== 0) process.exit(1);
NODE
  then
    error "The exact same-image migration task did not stop successfully."
    return 1
  fi
  success "Same-image startup migrations completed"
}

observe_same_image_safe_terminal() {
  if AWS_MAX_ATTEMPTS=1 same_image_service_contract_preflight \
      "$SAME_IMAGE_API_TASK_DEFINITION" "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
      "during bounded candidate recovery" > /dev/null 2>&1 &&
     AWS_MAX_ATTEMPTS=1 same_image_runtime_task_network_preflight \
      "$SAME_IMAGE_API_TASK_DEFINITION" "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
      "during bounded candidate recovery" > /dev/null 2>&1 &&
     AWS_MAX_ATTEMPTS=1 same_image_nat_posture_preflight > /dev/null 2>&1; then
    SAME_IMAGE_RECOVERY_TERMINAL="candidate"
    return 0
  fi
  if AWS_MAX_ATTEMPTS=1 same_image_service_contract_preflight \
      "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
      "during bounded source recovery" > /dev/null 2>&1 &&
     AWS_MAX_ATTEMPTS=1 same_image_runtime_task_network_preflight \
      "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
      "during bounded source recovery" > /dev/null 2>&1 &&
     AWS_MAX_ATTEMPTS=1 same_image_nat_posture_preflight > /dev/null 2>&1; then
    SAME_IMAGE_RECOVERY_TERMINAL="source"
    return 0
  fi
  return 1
}

recover_same_image_mutated_services() {
  local attempt
  SAME_IMAGE_RECOVERY_TERMINAL=""

  # A circuit breaker may already have returned both services to the captured
  # source revisions. Observe that exact safe state before continuing the
  # intended same-digest clone rollout.
  if observe_same_image_safe_terminal; then
    SAME_IMAGE_SAFE_TERMINAL_REACHED=true
    success "Same-image failure recovery observed exact ${SAME_IMAGE_RECOVERY_TERMINAL} revisions before retry."
    return 0
  fi

  warn "Reasserting only the reviewed digest-identical API and worker clone revisions during bounded recovery..."
  if ! AWS_MAX_ATTEMPTS=1 aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$SAME_IMAGE_API_TASK_DEFINITION" \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30 \
    --no-cli-pager > /dev/null; then
    warn "Could not reassert the exact same-image API clone; continuing bounded observation."
  fi
  if ! AWS_MAX_ATTEMPTS=1 aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$WORKER_SERVICE" \
    --task-definition "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
    --output json \
    --region "$REGION" \
    --cli-connect-timeout 10 \
    --cli-read-timeout 30 \
    --no-cli-pager > /dev/null; then
    warn "Could not reassert the exact same-image worker clone; continuing bounded observation."
  fi

  for ((attempt = 1; attempt <= SAME_IMAGE_RECOVERY_MAX_ATTEMPTS; attempt++)); do
    if observe_same_image_safe_terminal; then
      SAME_IMAGE_SAFE_TERMINAL_REACHED=true
      success "Same-image failure recovery reached exact ${SAME_IMAGE_RECOVERY_TERMINAL} revisions while the autoscaling hold remained active."
      return 0
    fi
    if (( attempt < SAME_IMAGE_RECOVERY_MAX_ATTEMPTS )); then
      sleep "$SAME_IMAGE_RECOVERY_POLL_SECONDS"
    fi
  done
  return 1
}

emit_same_image_hard_stop_record() {
  local reason="$1" record
  if ! record=$(SAME_IMAGE_HARD_STOP_REASON="$reason" \
    SAME_IMAGE_HARD_STOP_STAGE="$SAME_IMAGE_NETWORKING_STAGE" \
    SAME_IMAGE_HARD_STOP_APP_SHA="$EXPECTED_APP_SHA" \
    SAME_IMAGE_HARD_STOP_DIGEST="$EXPECTED_IMAGE_DIGEST" \
    SAME_IMAGE_HARD_STOP_SOURCE_API="$EXPECTED_API_TASK_DEFINITION" \
    SAME_IMAGE_HARD_STOP_SOURCE_WORKER="$EXPECTED_WORKER_TASK_DEFINITION" \
    SAME_IMAGE_HARD_STOP_CANDIDATE_API="$SAME_IMAGE_API_TASK_DEFINITION" \
    SAME_IMAGE_HARD_STOP_CANDIDATE_WORKER="$SAME_IMAGE_WORKER_TASK_DEFINITION" \
    SAME_IMAGE_HARD_STOP_NETWORK_HASH="$SAME_IMAGE_BOUND_NETWORK_HASH" \
    SAME_IMAGE_HARD_STOP_ATTEMPTS="$SAME_IMAGE_RECOVERY_MAX_ATTEMPTS" node <<'NODE'
const record = {
  schemaVersion: 1,
  event: "same_image_deploy_hard_stop",
  timestamp: new Date().toISOString(),
  reason: process.env.SAME_IMAGE_HARD_STOP_REASON,
  stage: process.env.SAME_IMAGE_HARD_STOP_STAGE,
  applicationSha: process.env.SAME_IMAGE_HARD_STOP_APP_SHA,
  imageDigest: process.env.SAME_IMAGE_HARD_STOP_DIGEST,
  sourceApiTaskDefinition: process.env.SAME_IMAGE_HARD_STOP_SOURCE_API,
  sourceWorkerTaskDefinition: process.env.SAME_IMAGE_HARD_STOP_SOURCE_WORKER,
  candidateApiTaskDefinition: process.env.SAME_IMAGE_HARD_STOP_CANDIDATE_API,
  candidateWorkerTaskDefinition: process.env.SAME_IMAGE_HARD_STOP_CANDIDATE_WORKER,
  networkConfigurationSha256: process.env.SAME_IMAGE_HARD_STOP_NETWORK_HASH,
  boundedRecoveryAttempts: Number(process.env.SAME_IMAGE_HARD_STOP_ATTEMPTS),
  dynamicAutoscalingHoldRetained: true,
  operatorActionRequired: true,
};
process.stdout.write(JSON.stringify(record));
NODE
  ); then
    record='{"schemaVersion":1,"event":"same_image_deploy_hard_stop","reason":"record_generation_failed","dynamicAutoscalingHoldRetained":true,"operatorActionRequired":true}'
  fi
  error "SAME_IMAGE_HARD_STOP_RECORD ${record}"
}

same_image_networking_redeploy() {
  same_image_application_identity_preflight
  same_image_service_contract_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "before ${SAME_IMAGE_NETWORKING_STAGE} cloning"
  same_image_runtime_task_network_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "before ${SAME_IMAGE_NETWORKING_STAGE} cloning"
  same_image_nat_posture_preflight
  same_image_autoscaling_contract_preflight

  # Validate both source definitions before the first registration mutation.
  # Each request is a field-for-field clone after removing only ECS read-only
  # metadata; no template overlay or image rewrite is permitted in this mode.
  render_same_image_clone_request "api" "$EXPECTED_API_TASK_DEFINITION" "api"
  render_same_image_clone_request "worker" "$EXPECTED_WORKER_TASK_DEFINITION" "scheduler-worker"
  register_same_image_clone_request "api" "$EXPECTED_API_TASK_DEFINITION" "api"
  register_same_image_clone_request "worker" "$EXPECTED_WORKER_TASK_DEFINITION" "scheduler-worker"

  acquire_production_scaling_hold
  same_image_autoscaling_contract_preflight
  same_image_service_contract_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "under the autoscaling hold"
  same_image_runtime_task_network_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "under the autoscaling hold"
  same_image_nat_posture_preflight

  run_same_image_migration_task

  production_backend_deploy_window_preflight "before same-image service rollout"
  production_backend_capacity_preflight "after same-image migration under the autoscaling hold"
  same_image_autoscaling_contract_preflight
  same_image_service_contract_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "after migration"
  same_image_runtime_task_network_preflight \
    "$EXPECTED_API_TASK_DEFINITION" "$EXPECTED_WORKER_TASK_DEFINITION" \
    "after migration"
  same_image_nat_posture_preflight

  info "Updating API first to ${SAME_IMAGE_API_TASK_DEFINITION}..."
  # Set before the mutating request so a lost AWS response is treated as an
  # uncertain mutation and the EXIT trap retains the scaling hold.
  SAME_IMAGE_SERVICE_MUTATION_STARTED=true
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$SAME_IMAGE_API_TASK_DEFINITION" \
    --output json \
    --region "$REGION" \
    --no-cli-pager > /dev/null
  info "Updating singleton worker to ${SAME_IMAGE_WORKER_TASK_DEFINITION}..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$WORKER_SERVICE" \
    --task-definition "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
    --output json \
    --region "$REGION" \
    --no-cli-pager > /dev/null

  aws ecs wait services-stable \
    --cluster "$CLUSTER" \
    --services "$SERVICE" "$WORKER_SERVICE" \
    --region "$REGION"
  wait_for_production_backend_strict_stability \
    "$SAME_IMAGE_API_TASK_DEFINITION" \
    "$SAME_IMAGE_WORKER_TASK_DEFINITION"
  same_image_service_contract_preflight \
    "$SAME_IMAGE_API_TASK_DEFINITION" "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
    "after strict convergence"
  same_image_runtime_task_network_preflight \
    "$SAME_IMAGE_API_TASK_DEFINITION" "$SAME_IMAGE_WORKER_TASK_DEFINITION" \
    "after strict convergence"
  same_image_nat_posture_preflight
  SAME_IMAGE_SAFE_TERMINAL_REACHED=true

  if ! restore_production_scaling_hold; then
    error "Same-image deployment converged, but exact autoscaling restoration failed."
    return 1
  fi
  same_image_autoscaling_contract_preflight
  success "${SAME_IMAGE_NETWORKING_STAGE} same-image deployment complete: app=${EXPECTED_APP_SHA} digest=${EXPECTED_IMAGE_DIGEST} api=${SAME_IMAGE_API_TASK_DEFINITION} worker=${SAME_IMAGE_WORKER_TASK_DEFINITION} networkSha256=${SAME_IMAGE_NETWORK_HASH}"
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
info "2048 API:   $ACTIVATE_EMERGENCY"
info "RLS table:  ${ENABLE_RLS_TABLE:-unchanged}"
info "Tile plans: $RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE"
info "Plan rehearse: $RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL"
info "Plan observe:  $RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION"
info "Plan receipt:  ${REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL:+provided}"
info "Capacity release: $CAPACITY_ACCEPTANCE_RELEASE"
info "Same image: ${SAME_IMAGE_NETWORKING_STAGE:-false}"
echo ""

if ! validate_capacity_acceptance_authorization_mode; then
  exit 1
fi
if ! validate_emergency_activation_mode; then
  exit 1
fi
if ! validate_rls_table_enablement_mode; then
  exit 1
fi
if ! validate_capacity_acceptance_frontend_mode; then
  exit 1
fi
if ! validate_retired_certification_admission_mode; then
  exit 1
fi
if ! validate_same_image_networking_mode; then
  exit 1
fi
if ! validate_classpilot_tile_auth_plan_gate_mode; then
  exit 1
fi

# Verify AWS credentials
if ! aws sts get-caller-identity --region "$REGION" > /dev/null 2>&1; then
  error "AWS credentials not configured. Run 'aws configure' first."
  exit 1
fi
success "AWS credentials OK"

# Resolve project root (script lives in scripts/)
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
if [[ -n "$CAPACITY_ACCEPTANCE_FRONTEND_SHA" &&
      "$LOCAL_SHA" != "$CAPACITY_ACCEPTANCE_FRONTEND_SHA" ]]; then
  error "The capacity-acceptance frontend SHA does not match clean main == origin/main."
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

if [[ -n "$SAME_IMAGE_NETWORKING_STAGE" ]]; then
  success "Controller/tooling preflight OK: main@${LOCAL_SHA} has green GitHub checks"
  info "Deployed app identity: ${EXPECTED_APP_SHA} / ${EXPECTED_IMAGE_DIGEST}"
else
  IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
  success "Git deploy preflight OK: main@$IMAGE_TAG has green GitHub checks"
  info "Image tag:   $IMAGE_TAG"
fi

# A 200% API/worker rollout is safe under the reviewed 150-connection launch
# gate only while the API is stable at one or two tasks and the singleton
# worker is stable at one task. This check runs before Docker/ECR/ECS work and
# fails closed if ECS cannot provide one unambiguous two-service snapshot.
production_backend_deploy_window_preflight
production_backend_capacity_preflight
if [[ "$ENV" == "production" && "$DEPLOY_BACKEND" == true ]]; then
  # These are recovery identities, not observational scratch state.  The
  # strict-stability validator intentionally refreshes PRODUCTION_PREFLIGHT_*
  # while a rollout converges, so rollback must never read those mutable
  # variables after either service has been changed.
  PRODUCTION_ROLLBACK_API_TASK_DEFINITION="$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION"
  PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION="$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION"
  PRODUCTION_ROLLBACK_API_TASK_DEFINITION_ARN="$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION_ARN"
  PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION_ARN="$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION_ARN"
fi
launch_safe_active_api_preflight

# ============================================================================
# BACKEND DEPLOY
# ============================================================================
if [[ "$DEPLOY_BACKEND" == true ]]; then
  echo ""
  echo "=========================================="
  echo "  Backend: Docker → ECR → ECS"
  echo "=========================================="

  info "Validating active runtime SecureString metadata without decryption..."
  runtime_securestring_preflight
  success "Runtime SecureString metadata preflight passed"

  if [[ -n "$SAME_IMAGE_NETWORKING_STAGE" ]]; then
    same_image_networking_redeploy
    exit 0
  fi

  resolve_classpilot_tile_auth_candidate_network
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    if [[ ! "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" =~ ^[a-f0-9]{64}$ ]]; then
      error "The capacity-acceptance release could not bind the initial candidate network configuration."
      exit 1
    fi
    CAPACITY_ACCEPTANCE_NETWORK_SHA256="$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256"
  fi

  if [[ -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ]]; then
    production_backend_capacity_preflight "before rehearsal receipt consumption"
    if [[ "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
          "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
      error "The active API/worker baseline changed before rehearsal receipt consumption."
      exit 1
    fi
    info "Inspecting the fresh ClassPilot tile authorization candidate rehearsal receipt..."
    inspect_or_consume_classpilot_rehearsal_receipt inspect
    verify_classpilot_rehearsed_candidates
    local_rehearsal_receipt_sha="$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256"
    local_rehearsal_api="$API_ROLLOUT_TASK_DEF"
    local_rehearsal_worker="$WORKER_CANDIDATE_TASK_DEF"
    local_rehearsal_digest="$DIGEST"
    local_rehearsal_network_sha="$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256"
  else
  resolve_classpilot_candidate_source_task_definitions
  preflight_rls_table_enablement_sources

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

  info "Rendering task definition from the exact immutable serving API revision..."
  describe_exact_classpilot_candidate_task_definition \
    "$API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
    .taskdef-current.json
  cp .taskdef-current.json .taskdef-template.json

  # Relative paths so this works with Windows node under Git Bash too.
  ACCOUNT_ID="$ACCOUNT_ID" REGION="$REGION" PROJECT="$PROJECT" ENVIRONMENT="$ENV" \
    API_FAMILY="${NAME}-api" \
    EXPECTED_API_SOURCE_ARN="$API_CANDIDATE_SOURCE_TASK_DEFINITION_ARN" \
    IMAGE_REF="${ECR_REPO}@${DIGEST}" node -e '
    const fs = require("fs");
    const td = JSON.parse(fs.readFileSync(".taskdef-current.json", "utf8"));
    const template = JSON.parse(fs.readFileSync(".taskdef-template.json", "utf8"));
    if (td.taskDefinitionArn !== process.env.EXPECTED_API_SOURCE_ARN ||
        template.taskDefinitionArn !== process.env.EXPECTED_API_SOURCE_ARN ||
        td.status !== "ACTIVE" || template.status !== "ACTIVE") {
      throw new Error("API candidate source does not match the exact serving task definition");
    }
    const readonly = ["taskDefinitionArn","revision","status","requiresAttributes","compatibilities","registeredAt","registeredBy"];
    readonly.forEach(k => delete td[k]);

    for (const key of ["taskRoleArn","executionRoleArn","networkMode","requiresCompatibilities","cpu","memory","runtimePlatform","ephemeralStorage"]) {
      if (template[key] !== undefined) td[key] = template[key];
    }
    td.family = process.env.API_FAMILY;

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

    function reconcileOptionalSecrets(container, templateContainer) {
      const optionalNames = new Set(["GOOGLE_OAUTH_TOKEN_ENCRYPTION_KEY_PREVIOUS"]);
      const retiredNames = new Set(["OPENAI_API_KEY"]);
      const enabledNames = new Set((templateContainer.secrets || []).map(item => item.name));
      container.secrets = (container.secrets || []).filter(
        item => !retiredNames.has(item.name) &&
          (!optionalNames.has(item.name) || enabledNames.has(item.name))
      );
      container.environment = (container.environment || []).filter(
        item => !retiredNames.has(item.name) &&
          (!optionalNames.has(item.name) || enabledNames.has(item.name))
      );
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
    reconcileOptionalSecrets(container, templateContainer);
    migratePlaintextSecrets(container);
    dedupeEnvAgainstSecrets(container);

    fs.writeFileSync(".taskdef-new.json", JSON.stringify(td));
  '

  if [[ -n "$ENABLE_RLS_TABLE" ]]; then
    if ! node "$SCRIPT_DIR/enforce-deploy-rls-allowlist.mjs" add \
        --task-definition .taskdef-new.json \
        --container api \
        --table "$ENABLE_RLS_TABLE"; then
      error "The API candidate could not apply the reviewed RLS allowlist delta."
      exit 1
    fi
  fi

  STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN=$(aws ecs register-task-definition \
    --cli-input-json file://.taskdef-new.json \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text \
    --region "$REGION")
  standard_api_pattern="^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${NAME}-api:([1-9][0-9]*)$"
  if [[ ! "$STANDARD_API_CANDIDATE_TASK_DEFINITION_ARN" =~ $standard_api_pattern ]]; then
    error "The registered standard API candidate ARN was malformed."
    exit 1
  fi
  NEW_REV="${BASH_REMATCH[1]}"
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

  API_ROLLOUT_TASK_DEF="${NAME}-api:${NEW_REV}"
  if [[ "$ACTIVATE_EMERGENCY" == true ]]; then
    API_ROLLOUT_TASK_DEF="$EMERGENCY_TASK_DEF_ARN"
    success "Launch-safe API rollout selected: ${API_ROLLOUT_TASK_DEF} (512 CPU / 2048 MiB)"
  fi
  register_classpilot_candidate_worker_task_definition
  verify_registered_rls_table_enablement_candidates
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
    verify_classpilot_rehearsed_candidates
  fi
  fi

  # This opt-in release gate runs the exact digest-pinned 512/2048 revision in
  # the service VPC before the autoscaling hold, migration, or service update.
  # It cannot seed certification; it only proves the reviewed authorization
  # SQL plans and teaching-session school integrity for this release.
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
    if ! production_backend_deploy_window_preflight "before ClassPilot plan-gate execution"; then
      exit 1
    fi
  fi
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ||
        "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
    production_backend_capacity_preflight "before candidate read-only preflight"
    if [[ "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
          "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
      error "The active API/worker baseline changed after candidate preparation; refusing the read-only candidate preflight."
      exit 1
    fi
    if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
      if ! preflight_classpilot_tile_auth_plan_observation_admission; then
        exit 1
      fi
      set +e
      initialize_classpilot_tile_auth_plan_observation
      observation_initialization_result=$?
      if [[ "$observation_initialization_result" -ne 0 &&
            "$TILE_AUTH_PLAN_OBSERVATION_ATTEMPT_ADMITTED" != true ]]; then
        set -e
        error "The ClassPilot tile authorization observation attempt was not admitted."
        exit 1
      fi
      if [[ "$observation_initialization_result" -eq 0 &&
            "$TILE_AUTH_PLAN_OBSERVATION_INITIALIZATION_FAILED" != true ]]; then
        run_classpilot_tile_auth_plan_observation_task
        observation_task_result=$?
        if [[ "$observation_task_result" -ne 0 ]]; then
          set_classpilot_tile_auth_observation_collection_failure \
            "terminal_task_unavailable"
        fi
      elif [[ -z "$TILE_AUTH_PLAN_OBSERVATION_COLLECTION_JSON" ]]; then
        set_classpilot_tile_auth_observation_collection_failure \
          "terminal_task_unavailable"
      fi
      capture_classpilot_tile_auth_observation_final_network
      capture_classpilot_tile_auth_observation_final_posture
      write_classpilot_tile_auth_plan_observation_packet_v2
      observation_finalization_result=$?
      if [[ "$observation_finalization_result" -eq 0 ]]; then
        if ! cleanup_classpilot_tile_auth_plan_observation_controller_workspace; then
          observation_finalization_result=1
        fi
      else
        warn "Retaining the ACL-private ClassPilot observation controller workspace because terminal packet sealing or inspection failed."
      fi
      set -e
    fi
  fi
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_OBSERVATION" == true ]]; then
    if [[ "$observation_finalization_result" -ne 0 ]]; then
      error "Candidate base observation reached a sealed non-admissible terminal outcome."
      exit 1
    fi
    if [[ "$TILE_AUTH_PLAN_OBSERVATION_OUTCOME" != "base_eligible" ]]; then
      error "Candidate base observation sealed a valid base-ineligible result; the mandatory plan gate remains blocked."
      exit 1
    fi
    success "Candidate base observation complete; no rehearsal admission, full plan gate, migration, scaling hold, service update, frontend publication, fixture mutation, lease, or traffic action was attempted."
    exit 0
  fi
  if ! run_classpilot_tile_auth_plan_predeploy_with_retry \
    "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL"; then
    exit 1
  fi
  if [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" == true ]]; then
    write_classpilot_rehearsal_receipt
    success "Candidate gate-only rehearsal complete; receipt is inspectable and unconsumed, and no rehearsal attempt, migration, scaling hold, service update, frontend publication, fixture mutation, lease, or traffic action was attempted."
    exit 0
  fi
  production_backend_capacity_preflight "after strict predeploy plan gate"
  if [[ "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
        "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
    error "The active API/worker baseline changed after the strict predeploy plan gate."
    exit 1
  fi
  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    if ! assert_capacity_acceptance_network_unchanged; then
      error "The capacity-acceptance network baseline drifted before the guarded deployment."
      exit 1
    fi
    success "Capacity-acceptance predeploy gate passed; no observation, rehearsal admission, or rehearsal receipt was required or consumed."
  elif [[ -n "$REUSE_CLASSPILOT_TILE_AUTH_PLAN_REHEARSAL" ]]; then
    if ! assert_classpilot_rehearsal_network_unchanged "$local_rehearsal_network_sha"; then
      error "The rehearsal baseline drifted before the guarded deployment."
      exit 1
    fi
    inspect_or_consume_classpilot_rehearsal_receipt consume
    if [[ "$TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256" != "$local_rehearsal_receipt_sha" ||
          "$API_ROLLOUT_TASK_DEF" != "$local_rehearsal_api" ||
          "$WORKER_CANDIDATE_TASK_DEF" != "$local_rehearsal_worker" ||
          "$DIGEST" != "$local_rehearsal_digest" ||
          "$TILE_AUTH_PLAN_REHEARSAL_NETWORK_SHA256" != "$local_rehearsal_network_sha" ]]; then
      error "The rehearsal receipt binding changed between inspection and its single-use consumption."
      exit 1
    fi
    TILE_AUTH_PLAN_REHEARSAL_CONSUMED_NETWORK_SHA256="$local_rehearsal_network_sha"
    success "Consumed the one-use candidate rehearsal receipt immediately before production mutation (receiptSha256=${TILE_AUTH_PLAN_REHEARSAL_RECEIPT_SHA256})"
  fi

  # Acquire the hold only after the slow image and task-definition work, then
  # keep it through the one-off migration and both ECS service deployments.
  # The helper rechecks API/worker stability after scaling is suspended.
  acquire_production_scaling_hold
  launch_safe_active_api_preflight

  MIGRATION_OVERRIDES=$(ENABLE_RLS_TABLE="$ENABLE_RLS_TABLE" node -e '
    const environment = [
      { name: "RUN_MIGRATIONS_ONLY", value: "true" },
      { name: "SCHEDULER_ENABLED", value: "false" },
    ];
    if (process.env.ENABLE_RLS_TABLE) {
      environment.push({
        name: "REQUIRE_RLS_TABLE_ENFORCEMENT",
        value: process.env.ENABLE_RLS_TABLE,
      });
    }
    process.stdout.write(JSON.stringify({
      containerOverrides: [{ name: "api", environment }],
    }));
  ')
  info "Running startup migrations with ${API_ROLLOUT_TASK_DEF}..."
  aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --network-configuration "$NETWORK_CONFIG" \
    --overrides "$MIGRATION_OVERRIDES" \
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

  info "Migration task started: ${MIGRATION_TASK_ARN}"
  set +e
  wait_for_migration_task_stopped "$MIGRATION_TASK_ARN"
  MIGRATION_WAIT_RESULT=$?
  set -e

  aws ecs describe-tasks \
    --cluster "$CLUSTER" \
    --tasks "$MIGRATION_TASK_ARN" \
    --query 'tasks[0].containers[0].{exitCode:exitCode,reason:reason,logStream:logStreamName}' \
    --output json \
    --region "$REGION" > .migration-result.json

  if [[ "$MIGRATION_WAIT_RESULT" -eq 124 ]]; then
    error "Migration task exceeded the controller deadline and was stopped. No ECS service rollout was attempted."
    cat .migration-result.json
    if [[ -f .migration-stop.json ]]; then
      cat .migration-stop.json
    fi
    exit 1
  elif [[ "$MIGRATION_WAIT_RESULT" -eq 125 ]]; then
    error "Migration task did not report STOPPED within the bounded five-minute stop-observation window. No ECS service rollout was attempted."
    cat .migration-result.json
    if [[ -f .migration-stop.json ]]; then
      cat .migration-stop.json
    fi
    exit 1
  elif [[ "$MIGRATION_WAIT_RESULT" -ne 0 ]]; then
    error "Migration task observation failed for ${MIGRATION_TASK_ARN}. No ECS service rollout was attempted."
    cat .migration-result.json
    exit 1
  fi

  MIGRATION_EXIT_CODE=$(node -e '
    const fs = require("fs");
    const result = JSON.parse(fs.readFileSync(".migration-result.json", "utf8"));
    console.log(result.exitCode ?? 1);
  ')
  if [[ "$MIGRATION_EXIT_CODE" != "0" ]]; then
    error "Migration task failed:"
    cat .migration-result.json
    exit 1
  fi
  rm -f .ecs-network.json .migration-task.json .migration-result.json .migration-stop.json
  success "Startup migrations completed"

  # Step 6: Point the API service at the new revision
  production_backend_deploy_window_preflight "before service rollout"
  production_backend_capacity_preflight "after migration under the autoscaling hold"
  if [[ "$PRODUCTION_PREFLIGHT_API_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_API_TASK_DEFINITION" ||
        "$PRODUCTION_PREFLIGHT_WORKER_TASK_DEFINITION" != "$PRODUCTION_ROLLBACK_WORKER_TASK_DEFINITION" ]]; then
    error "Production ECS task revisions changed after the immutable rollback identities were captured; refusing the service rollout."
    exit 1
  fi
  if ! assert_classpilot_rehearsal_network_unchanged; then
    error "The consumed rehearsal network binding drifted before service rollout."
    exit 1
  fi
  if ! assert_capacity_acceptance_network_unchanged; then
    error "The capacity-acceptance network binding drifted before service rollout."
    exit 1
  fi
  launch_safe_active_api_preflight
  info "Updating ECS API service to ${API_ROLLOUT_TASK_DEF}..."
  # Set before the request because a lost CLI response can leave an applied,
  # otherwise unobserved service mutation. The EXIT trap restores both exact
  # predeployment revisions until postdeploy identity and scaling are sealed.
  CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=true
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
    --region "$REGION" \
    --query 'service.{status:status,desired:desiredCount,running:runningCount,taskDef:taskDefinition}' \
    --output table

  UPDATED_WORKER=false
  if [[ "$(ecs_service_status "$WORKER_SERVICE")" == "ACTIVE" ]]; then
    if [[ ! "$WORKER_CANDIDATE_TASK_DEF" =~ ^arn:aws:ecs:${REGION}:${ACCOUNT_ID}:task-definition/${WORKER_SERVICE}:[1-9][0-9]*$ ]]; then
      error "The exact rehearsed scheduler-worker candidate binding is missing or malformed."
      exit 1
    fi
    info "Updating scheduler worker service to exact candidate ${WORKER_CANDIDATE_TASK_DEF}..."
    aws ecs update-service \
      --cluster "$CLUSTER" \
      --service "$WORKER_SERVICE" \
      --task-definition "$WORKER_CANDIDATE_TASK_DEF" \
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
  # scaling remains in its captured state, and the guarded deployment window
  # keeps the 05:45/10:00 actions away from the 200% rollout.
  wait_for_production_backend_strict_stability \
    "$API_ROLLOUT_TASK_DEF" \
    "${WORKER_SERVICE}:${WORKER_NEW_REV}"

  # Re-run the exact non-executing identity gate from the now-active API
  # revision after migrations and strict convergence. Any query-id/schema drift
  # fails closed, restores both services, and blocks test preparation.
  if ! run_classpilot_tile_auth_plan_gate postdeploy; then
    error "The post-deployment ClassPilot SQL identity gate failed; rolling back this release."
    if ! rollback_classpilot_tile_auth_deployment; then
      error "The guarded rollback or restoration could not be proven. Manual recovery is required immediately."
    fi
    exit 1
  fi

  if ! restore_production_scaling_hold; then
    error "Backend deployment stabilized, but autoscaling restoration failed; failing the deploy and retrying restoration from the EXIT trap."
    exit 1
  fi
  CLASSPILOT_TILE_AUTH_SERVICE_MUTATION_STARTED=false
  CLASSPILOT_TILE_AUTH_SAFE_TERMINAL_REACHED=true

  if [[ "$CAPACITY_ACCEPTANCE_RELEASE" == true ]]; then
    success "Capacity-acceptance backend release complete; strict rollback-only predeploy and active-revision plan gates passed."
  elif [[ "$RUN_CLASSPILOT_TILE_AUTH_PLAN_GATE" == true ]]; then
    success "Backend deploy complete (historyFallbackIdentityReceiptPathSha256=${TILE_AUTH_PLAN_IDENTITY_RECEIPT_PATH_SHA256}, receiptSha256=${TILE_AUTH_PLAN_IDENTITY_RECEIPT_SHA256})"
  else
    success "Backend deploy complete!"
  fi
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
  CLOUDFRONT_INVALIDATION_ID=$(MSYS_NO_PATHCONV=1 aws cloudfront create-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --paths "/index.html" "/" \
    --query 'Invalidation.Id' \
    --output text \
    --no-cli-pager)
  CLOUDFRONT_INVALIDATION_ID="${CLOUDFRONT_INVALIDATION_ID%$'\r'}"
  if [[ ! "$CLOUDFRONT_INVALIDATION_ID" =~ ^I[A-Z0-9]+$ ]]; then
    error "CloudFront did not return one exact invalidation ID."
    exit 1
  fi
  info "Waiting for CloudFront invalidation ${CLOUDFRONT_INVALIDATION_ID}..."
  aws cloudfront wait invalidation-completed \
    --distribution-id "$CF_DIST_ID" \
    --id "$CLOUDFRONT_INVALIDATION_ID" \
    --no-cli-pager
  CLOUDFRONT_INVALIDATION_STATUS=$(aws cloudfront get-invalidation \
    --distribution-id "$CF_DIST_ID" \
    --id "$CLOUDFRONT_INVALIDATION_ID" \
    --query 'Invalidation.Status' \
    --output text \
    --no-cli-pager)
  CLOUDFRONT_INVALIDATION_STATUS="${CLOUDFRONT_INVALIDATION_STATUS%$'\r'}"
  if [[ "$CLOUDFRONT_INVALIDATION_STATUS" != "Completed" ]]; then
    error "CloudFront invalidation did not reach Completed."
    exit 1
  fi
  success "CloudFront invalidation completed (id=${CLOUDFRONT_INVALIDATION_ID}, appSha=${LOCAL_SHA})"

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
  if [[ "$ACTIVATE_EMERGENCY" == true ]]; then
    echo "  API target: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION}, 512 CPU / 2048 MiB; active)"
  else
    echo "  OOM target: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION}, 512 CPU / 2048 MiB; not deployed)"
  fi
fi
[[ "$DEPLOY_FRONTEND" == true ]] && echo "  Frontend: S3 synced, CloudFront invalidated"
echo ""
