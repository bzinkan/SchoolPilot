import hashlib
import json
import re
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import (
    ClientError,
    ConnectTimeoutError,
    ConnectionClosedError,
    EndpointConnectionError,
    ReadTimeoutError,
)


_RETRY_DELAYS_SECONDS = (0, 1, 2, 4)
_RETRYABLE_CODES = {
    "InternalError",
    "InternalFailure",
    "RequestLimitExceeded",
    "ServiceUnavailable",
    "Throttling",
    "ThrottlingException",
    "TooManyRequestsException",
}
_RDS_CONCURRENT_MODIFICATION_CODES = {
    "InvalidDBInstanceState",
    "InvalidDBInstanceStateFault",
}
_TRANSIENT_EXCEPTIONS = (
    ConnectTimeoutError,
    ConnectionClosedError,
    EndpointConnectionError,
    ReadTimeoutError,
)
_CLIENT_CONFIG = Config(connect_timeout=10, read_timeout=20, retries={"max_attempts": 0})
_SCHEDULE_TARGET_ARN = "arn:aws:scheduler:::aws-sdk:ssm:startAutomationExecution"
_AUTOMATION_CONTRACT_VERSION = "ssm-rds-monitoring-restore-v2"
_PRESERVED_POSTURE_ENCODING_VERSION = "rds-preserved-monitoring-posture-json-v1"
_PRESERVED_POSTURE_FIELDS = (
    "version",
    "performanceInsightsKmsKeyId",
    "monitoringInterval",
    "monitoringRoleArn",
    "enabledCloudwatchLogsExports",
)
_SUPPORTED_MONITORING_INTERVALS = {0, 1, 5, 10, 15, 30, 60}
_SUPPORTED_POSTGRES_LOG_EXPORTS = {
    "iam-db-auth-error",
    "postgresql",
    "upgrade",
}
_LOWERCASE_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_IAM_ROLE_ARN = re.compile(
    r"^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role/"
    r"[A-Za-z0-9+=,.@_/-]{1,512}$"
)


def _call(operation, **kwargs):
    last_error = None
    for attempt, delay in enumerate(_RETRY_DELAYS_SECONDS):
        if delay:
            time.sleep(delay)
        try:
            return operation(**kwargs)
        except _TRANSIENT_EXCEPTIONS as error:
            last_error = error
        except ClientError as error:
            code = error.response.get("Error", {}).get("Code", "")
            if code not in _RETRYABLE_CODES and not code.startswith("Throttl"):
                raise
            last_error = error
        if attempt == len(_RETRY_DELAYS_SECONDS) - 1:
            raise last_error
    raise RuntimeError("bounded AWS retry loop exited unexpectedly")


def _decode_json_without_duplicate_keys(value):
    def reject_duplicates(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError("duplicate JSON property")
            result[key] = item
        return result

    return json.loads(value, object_pairs_hook=reject_duplicates)


def _canonical_preserved_posture_json(posture):
    canonical = {
        "version": posture["version"],
        "performanceInsightsKmsKeyId": posture[
            "performanceInsightsKmsKeyId"
        ],
        "monitoringInterval": posture["monitoringInterval"],
        "monitoringRoleArn": posture["monitoringRoleArn"],
        "enabledCloudwatchLogsExports": posture[
            "enabledCloudwatchLogsExports"
        ],
    }
    return json.dumps(canonical, separators=(",", ":"), ensure_ascii=False)


def _parse_preserved_monitoring_posture(events):
    encoding = events.get("preservedMonitoringPostureEncodingVersion")
    if encoding != _PRESERVED_POSTURE_ENCODING_VERSION:
        raise RuntimeError("preserved monitoring posture encoding version drifted")

    raw = events.get("expectedPreservedMonitoringPostureJson")
    expected_sha256 = events.get("expectedPreservedMonitoringPostureSha256")
    if not isinstance(raw, str) or not raw:
        raise RuntimeError("preserved monitoring posture JSON was not bound")
    if not isinstance(expected_sha256, str) or not _LOWERCASE_SHA256.fullmatch(
        expected_sha256
    ):
        raise RuntimeError("preserved monitoring posture hash was malformed")
    actual_sha256 = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError("preserved monitoring posture hash did not match")

    try:
        posture = _decode_json_without_duplicate_keys(raw)
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("preserved monitoring posture JSON was malformed") from error
    if not isinstance(posture, dict) or tuple(posture) != _PRESERVED_POSTURE_FIELDS:
        raise RuntimeError("preserved monitoring posture fields were not canonical")
    if posture.get("version") != _PRESERVED_POSTURE_ENCODING_VERSION:
        raise RuntimeError("preserved monitoring posture body version drifted")

    kms_key_id = posture.get("performanceInsightsKmsKeyId")
    if (
        not isinstance(kms_key_id, str)
        or not kms_key_id.strip()
        or kms_key_id != kms_key_id.strip()
    ):
        raise RuntimeError("preserved monitoring posture KMS identity was invalid")

    monitoring_interval = posture.get("monitoringInterval")
    if (
        isinstance(monitoring_interval, bool)
        or not isinstance(monitoring_interval, int)
        or monitoring_interval not in _SUPPORTED_MONITORING_INTERVALS
    ):
        raise RuntimeError("preserved monitoring interval was invalid")

    arn_parts = str(events.get("expectedDbInstanceArn", "")).split(":")
    if (
        len(arn_parts) != 7
        or arn_parts[0] != "arn"
        or arn_parts[2] != "rds"
        or arn_parts[5] != "db"
        or not arn_parts[4].isdigit()
        or len(arn_parts[4]) != 12
    ):
        raise RuntimeError("bound database ARN is malformed")
    monitoring_role_arn = posture.get("monitoringRoleArn")
    if monitoring_interval == 0:
        if monitoring_role_arn is not None:
            raise RuntimeError(
                "disabled enhanced monitoring must encode an explicit null role"
            )
    else:
        if not isinstance(monitoring_role_arn, str):
            raise RuntimeError("enabled enhanced monitoring role was invalid")
        role_match = _IAM_ROLE_ARN.fullmatch(monitoring_role_arn)
        if (
            role_match is None
            or role_match.group(1) != arn_parts[1]
            or role_match.group(2) != arn_parts[4]
        ):
            raise RuntimeError("enabled enhanced monitoring role was invalid")

    exports = posture.get("enabledCloudwatchLogsExports")
    if not isinstance(exports, list) or any(
        not isinstance(value, str)
        or not value
        or value not in _SUPPORTED_POSTGRES_LOG_EXPORTS
        for value in exports
    ):
        raise RuntimeError("preserved PostgreSQL log exports were invalid")
    if exports != sorted(set(exports)):
        raise RuntimeError("preserved PostgreSQL log exports were not canonical")

    if raw != _canonical_preserved_posture_json(posture):
        raise RuntimeError("preserved monitoring posture JSON was not canonical")
    return posture


def _describe_exact_database(rds, events):
    instances = _call(
        rds.describe_db_instances,
        DBInstanceIdentifier=events["dbInstanceIdentifier"],
    ).get("DBInstances", [])
    if len(instances) != 1:
        raise RuntimeError("exact database identity was not singular")
    db = instances[0]
    immutable_identity = (
        db.get("DBInstanceIdentifier") == events["dbInstanceIdentifier"]
        and db.get("DBInstanceArn") == events["expectedDbInstanceArn"]
        and db.get("DbiResourceId") == events["expectedDatabaseResourceId"]
        and db.get("DBInstanceClass") == events["expectedDbInstanceClass"]
        and db.get("Engine") == "postgres"
        and db.get("EngineVersion") == events["expectedEngineVersion"]
    )
    if not immutable_identity:
        raise RuntimeError("immutable database identity drifted during restoration")
    return db


def _is_exact_posture(db, events, expected_posture):
    parameter_groups = db.get("DBParameterGroups", [])
    expected_role_arn = expected_posture["monitoringRoleArn"]
    observed_role_arn = db.get("MonitoringRoleArn") or None
    return (
        db.get("DBInstanceStatus") == "available"
        and db.get("DatabaseInsightsMode") == "standard"
        and db.get("PerformanceInsightsEnabled") is True
        and db.get("PerformanceInsightsRetentionPeriod") == 7
        and db.get("PerformanceInsightsKMSKeyId", "")
        == expected_posture["performanceInsightsKmsKeyId"]
        and db.get("MonitoringInterval", 0)
        == expected_posture["monitoringInterval"]
        and observed_role_arn == expected_role_arn
        and sorted(db.get("EnabledCloudwatchLogsExports", []))
        == expected_posture["enabledCloudwatchLogsExports"]
        and db.get("PendingModifiedValues", {}) == {}
        and len(parameter_groups) > 0
        and all(
            group.get("ParameterApplyStatus") == "in-sync"
            for group in parameter_groups
        )
    )


def _parse_schedule_time(value):
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise RuntimeError("restore schedule timestamp omitted its UTC offset")
    return parsed.astimezone(timezone.utc)


def _expected_schedule(events):
    _parse_preserved_monitoring_posture(events)
    arn_parts = events["expectedDbInstanceArn"].split(":")
    if len(arn_parts) != 7 or arn_parts[2] != "rds" or arn_parts[5] != "db":
        raise RuntimeError("bound database ARN is malformed")
    region = arn_parts[3]
    account_id = arn_parts[4]
    group_name = events["restoreScheduleGroupName"]
    suffix = "-db-insights-leases"
    if not group_name.endswith(suffix):
        raise RuntimeError("bound restore schedule group is malformed")
    name_prefix = group_name[: -len(suffix)]
    if (
        events.get("automationDocumentName")
        != f"{name_prefix}-db-insights-restore-v2"
        or events.get("automationDocumentVersion") != "1"
    ):
        raise RuntimeError("restore automation document binding drifted")
    role_arn = f"arn:aws:iam::{account_id}:role/{name_prefix}-db-insights-restore"
    automation_role_arn = (
        f"arn:aws:iam::{account_id}:role/{name_prefix}-db-insights-restore-automation"
    )
    queue_name = f"{name_prefix}-db-insights-restore-dlq"
    queue_arn = f"arn:aws:sqs:{region}:{account_id}:{queue_name}"
    queue_url = f"https://sqs.{region}.amazonaws.com/{account_id}/{queue_name}"
    schedule_arn = (
        f"arn:aws:scheduler:{region}:{account_id}:schedule/"
        f"{group_name}/{events['restoreScheduleName']}"
    )
    binding_material = "|".join(
        (
            account_id,
            region,
            events["dbInstanceIdentifier"],
            events["expiresAtUtc"],
            events["leaseIdSha256"],
        )
    )
    description_binding = hashlib.sha256(binding_material.encode("utf-8")).hexdigest()
    description = (
        "SchoolPilot db-insights restore v3 "
        f"lease={events['leaseIdSha256']} binding={description_binding}"
    )
    parameters = {
        "AutomationAssumeRole": [automation_role_arn],
        "DBInstanceIdentifier": [events["dbInstanceIdentifier"]],
        "ExpectedDBInstanceArn": [events["expectedDbInstanceArn"]],
        "ExpectedDatabaseResourceId": [events["expectedDatabaseResourceId"]],
        "ExpectedDBInstanceClass": [events["expectedDbInstanceClass"]],
        "ExpectedEngineVersion": [events["expectedEngineVersion"]],
        "PreservedMonitoringPostureEncodingVersion": [
            events["preservedMonitoringPostureEncodingVersion"]
        ],
        "ExpectedPreservedMonitoringPostureJson": [
            events["expectedPreservedMonitoringPostureJson"]
        ],
        "ExpectedPreservedMonitoringPostureSha256": [
            events["expectedPreservedMonitoringPostureSha256"]
        ],
        "FailureQueueUrl": [queue_url],
        "RestoreScheduleName": [events["restoreScheduleName"]],
        "RestoreScheduleGroupName": [group_name],
        "AutomationDocumentContentSha256": [
            events["automationDocumentContentSha256"]
        ],
        "LeaseIdSha256": [events["leaseIdSha256"]],
        "ExpiresAtUtc": [events["expiresAtUtc"]],
        "RestoreMode": ["scheduled"],
    }
    target_input = {
        "DocumentName": events["automationDocumentName"],
        "DocumentVersion": events["automationDocumentVersion"],
        "Parameters": parameters,
    }
    target = {
        "Arn": _SCHEDULE_TARGET_ARN,
        "RoleArn": role_arn,
        "Input": json.dumps(target_input, separators=(",", ":")),
        "DeadLetterConfig": {"Arn": queue_arn},
        "RetryPolicy": {
            "MaximumEventAgeInSeconds": int(events["maximumEventAgeInSeconds"]),
            "MaximumRetryAttempts": 0,
        },
    }
    return {
        "accountId": account_id,
        "region": region,
        "scheduleArn": schedule_arn,
        "description": description,
        "target": target,
    }


def _read_guard(scheduler, events):
    try:
        schedule = _call(
            scheduler.get_schedule,
            Name=events["restoreScheduleName"],
            GroupName=events["restoreScheduleGroupName"],
        )
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            return "absent", None
        raise

    expected = _expected_schedule(events)
    target = schedule.get("Target", {})
    try:
        target_input = _decode_json_without_duplicate_keys(target.get("Input", "{}"))
        expected_target_input = _decode_json_without_duplicate_keys(
            expected["target"]["Input"]
        )
    except (TypeError, ValueError):
        return "superseded", schedule
    state = schedule.get("State")
    schedule_keys = set(schedule) - {"ResponseMetadata"}
    exact = (
        schedule_keys
        == {
            "ActionAfterCompletion",
            "Arn",
            "CreationDate",
            "Description",
            "FlexibleTimeWindow",
            "GroupName",
            "LastModificationDate",
            "Name",
            "ScheduleExpression",
            "ScheduleExpressionTimezone",
            "StartDate",
            "State",
            "Target",
        }
        and state in ("ENABLED", "DISABLED")
        and schedule.get("Arn") == expected["scheduleArn"]
        and schedule.get("Name") == events["restoreScheduleName"]
        and schedule.get("GroupName") == events["restoreScheduleGroupName"]
        and schedule.get("Description") == expected["description"]
        and schedule.get("ScheduleExpression") == "rate(15 minutes)"
        and _parse_schedule_time(schedule.get("StartDate"))
        == _parse_schedule_time(events["expiresAtUtc"])
        and schedule.get("EndDate") is None
        and schedule.get("KmsKeyArn") is None
        and schedule.get("ScheduleExpressionTimezone") == "UTC"
        and schedule.get("ActionAfterCompletion") == "NONE"
        and schedule.get("FlexibleTimeWindow") == {"Mode": "OFF"}
        and set(target) == {"Arn", "RoleArn", "Input", "DeadLetterConfig", "RetryPolicy"}
        and target.get("Arn") == expected["target"]["Arn"]
        and target.get("RoleArn") == expected["target"]["RoleArn"]
        and target_input == expected_target_input
        and target.get("DeadLetterConfig") == expected["target"]["DeadLetterConfig"]
        and target.get("RetryPolicy") == expected["target"]["RetryPolicy"]
    )
    return ("exact", schedule) if exact else ("superseded", schedule)


def _disable_exact_guard(rds, scheduler, events, expected_posture):
    expected = _expected_schedule(events)
    try:
        _call(
            scheduler.update_schedule,
            Name=events["restoreScheduleName"],
            GroupName=events["restoreScheduleGroupName"],
            Description=expected["description"],
            ScheduleExpression="rate(15 minutes)",
            StartDate=_parse_schedule_time(events["expiresAtUtc"]),
            ScheduleExpressionTimezone="UTC",
            FlexibleTimeWindow={"Mode": "OFF"},
            Target=expected["target"],
            ActionAfterCompletion="NONE",
            State="DISABLED",
        )
    except ClientError as error:
        # Two same-generation manual restorers may race the identical disarm.
        # Scheduler documents ConflictException for this inconsistent-state
        # window. The conflict itself is never success; the exact generation
        # must be observed DISABLED (or already removed after exact RDS
        # convergence) below.
        if error.response.get("Error", {}).get("Code") != "ConflictException":
            raise
    except _TRANSIENT_EXCEPTIONS:
        # A timed-out UpdateSchedule may have been accepted. Reconciliation is
        # safe only through an exact, freshly read schedule state below.
        pass

    # Scheduler reads can lag an accepted update. Bound reconciliation to the
    # existing delivery-age window and never accept ENABLED or drift as a
    # successful disarm.
    reconciliation_attempts = max(
        2, (int(events["maximumEventAgeInSeconds"]) // 5) + 1
    )
    for attempt in range(reconciliation_attempts):
        guard_state, disabled = _read_guard(scheduler, events)
        if guard_state == "superseded":
            raise RuntimeError("restore guard generation drifted during disable")
        if guard_state == "absent":
            db = _describe_exact_database(rds, events)
            if not _is_exact_posture(db, events, expected_posture):
                raise RuntimeError(
                    "restore guard disappeared before exact Standard/7 convergence"
                )
            return None
        if disabled.get("State") == "DISABLED":
            return disabled
        if attempt < reconciliation_attempts - 1:
            time.sleep(5)
    raise RuntimeError("exact restore schedule did not converge to disabled")


def _delete_exact_guard(rds, scheduler, events, expected_posture):
    reconciliation_attempts = max(
        2, (int(events["maximumEventAgeInSeconds"]) // 5) + 1
    )
    for attempt in range(reconciliation_attempts):
        try:
            _call(
                scheduler.delete_schedule,
                Name=events["restoreScheduleName"],
                GroupName=events["restoreScheduleGroupName"],
            )
        except ClientError as error:
            # Same-generation manual executions can race the identical delete.
            # Neither ConflictException nor ResourceNotFoundException proves
            # restoration; a fresh exact schedule/database read must do so.
            if error.response.get("Error", {}).get("Code") not in {
                "ConflictException",
                "ResourceNotFoundException",
            }:
                raise
        except _TRANSIENT_EXCEPTIONS:
            # DeleteSchedule may have been accepted before the client timed out.
            pass

        guard_state, schedule = _read_guard(scheduler, events)
        if guard_state == "superseded":
            raise RuntimeError("restore guard generation drifted during deletion")
        if guard_state == "absent":
            db = _describe_exact_database(rds, events)
            if not _is_exact_posture(db, events, expected_posture):
                raise RuntimeError(
                    "restore guard disappeared before exact Standard/7 convergence"
                )
            return
        if schedule.get("State") != "DISABLED":
            raise RuntimeError("exact restore schedule was re-enabled during deletion")
        if attempt < reconciliation_attempts - 1:
            time.sleep(5)
    raise RuntimeError("exact restore schedule remained after bounded deletion")


def _restore_exact_posture(rds, scheduler, events, expected_posture, restore_mode):
    deadline = time.monotonic() + 480
    modification_requested = False
    retry_after_concurrent_modification = False
    while True:
        db = _describe_exact_database(rds, events)
        if _is_exact_posture(db, events, expected_posture):
            return db
        if time.monotonic() >= deadline:
            raise RuntimeError("exact Standard/7 monitoring posture did not converge")
        # A concurrently delivered scheduled/manual execution may have won the
        # identical ModifyDBInstance race, then failed before convergence. Once
        # RDS becomes available again, permit this execution to retry the exact
        # guarded mutation rather than waiting until the lease deadline.
        if (
            retry_after_concurrent_modification
            and modification_requested
            and db.get("DBInstanceStatus") == "available"
        ):
            modification_requested = False
            retry_after_concurrent_modification = False
        if db.get("DBInstanceStatus") == "available" and not modification_requested:
            guard_state, schedule = _read_guard(scheduler, events)
            if guard_state == "absent":
                raise RuntimeError("restore guard disappeared before RDS mutation")
            if guard_state != "exact":
                raise RuntimeError("restore guard generation drifted before RDS mutation")
            try:
                _call(
                    rds.modify_db_instance,
                    DBInstanceIdentifier=events["dbInstanceIdentifier"],
                    DatabaseInsightsMode="standard",
                    EnablePerformanceInsights=True,
                    PerformanceInsightsRetentionPeriod=7,
                    ApplyImmediately=True,
                )
                modification_requested = True
            except ClientError as error:
                code = error.response.get("Error", {}).get("Code", "")
                if code not in _RDS_CONCURRENT_MODIFICATION_CODES:
                    raise

                # The state conflict is not itself success. Re-read the exact
                # immutable identity and monitoring posture. A concurrent
                # identical restore may now be in flight; bounded polling must
                # still prove exact Standard/7 before this execution succeeds.
                db = _describe_exact_database(rds, events)
                if _is_exact_posture(db, events, expected_posture):
                    return db
                modification_requested = db.get("DBInstanceStatus") != "available"
                retry_after_concurrent_modification = modification_requested
        time.sleep(15)


def handler(events, context):
    if events.get("automationContractVersion") != _AUTOMATION_CONTRACT_VERSION:
        raise RuntimeError("restore automation contract version drifted")
    restore_mode = events.get("restoreMode")
    if restore_mode not in ("scheduled", "manual"):
        raise RuntimeError("restore mode was not explicitly bound")
    if int(events.get("maximumEventAgeInSeconds", -1)) != 60:
        raise RuntimeError("restore delivery-grace binding drifted")

    expected_posture = _parse_preserved_monitoring_posture(events)
    rds = boto3.client("rds", config=_CLIENT_CONFIG)
    scheduler = boto3.client("scheduler", config=_CLIENT_CONFIG)
    guard_state, schedule = _read_guard(scheduler, events)
    if guard_state == "absent":
        db = _describe_exact_database(rds, events)
        if not _is_exact_posture(db, events, expected_posture):
            raise RuntimeError("restore guard disappeared before exact Standard/7 convergence")
        return {"verified": True, "guardAlreadyRemoved": True, "restoreMode": restore_mode}
    if guard_state != "exact":
        raise RuntimeError("restore guard generation was replaced or drifted")

    db = _restore_exact_posture(
        rds, scheduler, events, expected_posture, restore_mode
    )
    result = {
        "verified": True,
        "leaseIdSha256": events["leaseIdSha256"],
        "expiresAtUtc": events["expiresAtUtc"],
        "automationDocumentContentSha256": events[
            "automationDocumentContentSha256"
        ],
        "restoreMode": restore_mode,
    }
    if restore_mode == "scheduled":
        return result

    # Preserve the recurring AWS-native guard throughout posture convergence.
    # A failed/timed-out restore therefore remains retriable by Scheduler. Only
    # after exact Standard/7 is proven may the manual execution disarm it.
    guard_state, schedule = _read_guard(scheduler, events)
    if guard_state == "superseded":
        raise RuntimeError("restore guard generation drifted after posture convergence")
    if guard_state == "absent":
        db = _describe_exact_database(rds, events)
        if not _is_exact_posture(db, events, expected_posture):
            raise RuntimeError("restore guard disappeared after posture convergence")
        result["guardRemoved"] = True
        return result
    if schedule.get("State") == "ENABLED":
        schedule = _disable_exact_guard(
            rds, scheduler, events, expected_posture
        )
    elif schedule.get("State") != "DISABLED":
        raise RuntimeError("manual restore guard has an unsupported state")

    # Scheduler may already have delivered the final invocation when this
    # manual execution disabled the recurring guard. Keep this execution active
    # as the distributed barrier until the complete delivery-age window drains.
    time.sleep(int(events["maximumEventAgeInSeconds"]) + 5)
    db = _describe_exact_database(rds, events)
    if not _is_exact_posture(db, events, expected_posture):
        raise RuntimeError("exact Standard/7 posture drifted during delivery grace")

    guard_state, schedule = _read_guard(scheduler, events)
    if guard_state == "superseded":
        raise RuntimeError("restore guard generation drifted during disarm")
    if guard_state == "exact":
        if schedule.get("State") != "DISABLED":
            raise RuntimeError("exact restore schedule was re-enabled during disarm")
        _delete_exact_guard(rds, scheduler, events, expected_posture)

    db = _describe_exact_database(rds, events)
    if not _is_exact_posture(db, events, expected_posture):
        raise RuntimeError("exact Standard/7 posture drifted after guard removal")
    result["guardRemoved"] = True
    return result
