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

# --- Parse arguments ---
ENV="production"
DEPLOY_BACKEND=true
DEPLOY_FRONTEND=true
SKIP_WAIT=false
ACTIVATE_EMERGENCY=false
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
MIGRATION_TASK_WAIT_SECONDS=3600
MIGRATION_TASK_POLL_SECONDS=15
MIGRATION_TASK_STOP_WAIT_SECONDS=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backend)  DEPLOY_FRONTEND=false; shift ;;
    --frontend) DEPLOY_BACKEND=false; shift ;;
    --activate-emergency) ACTIVATE_EMERGENCY=true; shift ;;
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
        api_task_definition="$normalized_service_task_definition"
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
  PRODUCTION_PREFLIGHT_API_TASK_DEFINITION="$api_task_definition"
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

production_eastern_weekday_hhmm() {
  TZ=America/New_York date '+%u %H%M'
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
info "Same image: ${SAME_IMAGE_NETWORKING_STAGE:-false}"
echo ""

if ! validate_emergency_activation_mode; then
  exit 1
fi
if ! validate_same_image_networking_mode; then
  exit 1
fi

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

  API_ROLLOUT_TASK_DEF="${NAME}-api:${NEW_REV}"
  if [[ "$ACTIVATE_EMERGENCY" == true ]]; then
    API_ROLLOUT_TASK_DEF="$EMERGENCY_TASK_DEF_ARN"
    success "Launch-safe API rollout selected: ${API_ROLLOUT_TASK_DEF} (512 CPU / 2048 MiB)"
  fi

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
  launch_safe_active_api_preflight

  info "Running startup migrations with ${API_ROLLOUT_TASK_DEF}..."
  aws ecs run-task \
    --cluster "$CLUSTER" \
    --launch-type FARGATE \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
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
  launch_safe_active_api_preflight
  info "Updating ECS API service to ${API_ROLLOUT_TASK_DEF}..."
  aws ecs update-service \
    --cluster "$CLUSTER" \
    --service "$SERVICE" \
    --task-definition "$API_ROLLOUT_TASK_DEF" \
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

      const container = td.containerDefinitions.find(c => c.name === "scheduler-worker") || td.containerDefinitions[0];
      const apiContainer = (api.containerDefinitions || []).find(c => c.name === "api") || api.containerDefinitions?.[0] || {};
      container.image = process.env.IMAGE_REF;
      container.environment = mergeNamed(apiContainer.environment, container.environment);
      container.secrets = mergeNamed(apiContainer.secrets, container.secrets);
      reconcileOptionalSecrets(container, apiContainer);
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
  # scaling remains in its captured state, and the guarded deployment window
  # keeps the 05:45/10:00 actions away from the 200% rollout.
  wait_for_production_backend_strict_stability \
    "$API_ROLLOUT_TASK_DEF" \
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
  if [[ "$ACTIVATE_EMERGENCY" == true ]]; then
    echo "  API target: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION}, 512 CPU / 2048 MiB; active)"
  else
    echo "  OOM target: ${EMERGENCY_TASK_DEF_ARN} (revision ${EMERGENCY_TASK_DEF_REVISION}, 512 CPU / 2048 MiB; not deployed)"
  fi
fi
[[ "$DEPLOY_FRONTEND" == true ]] && echo "  Frontend: S3 synced, CloudFront invalidated"
echo ""
