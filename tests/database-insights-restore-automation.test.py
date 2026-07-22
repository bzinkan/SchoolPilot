import copy
import hashlib
import importlib.util
import json
import sys
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path


class ClientError(Exception):
    def __init__(self, code):
        self.response = {"Error": {"Code": code}}
        super().__init__(code)


class TransientError(Exception):
    pass


boto3_stub = types.ModuleType("boto3")
boto3_stub.client = lambda name, config=None: None
botocore_stub = types.ModuleType("botocore")
config_stub = types.ModuleType("botocore.config")
config_stub.Config = lambda **kwargs: kwargs
exceptions_stub = types.ModuleType("botocore.exceptions")
exceptions_stub.ClientError = ClientError
exceptions_stub.ConnectTimeoutError = TransientError
exceptions_stub.ConnectionClosedError = TransientError
exceptions_stub.EndpointConnectionError = TransientError
exceptions_stub.ReadTimeoutError = TransientError
sys.modules.update(
    {
        "boto3": boto3_stub,
        "botocore": botocore_stub,
        "botocore.config": config_stub,
        "botocore.exceptions": exceptions_stub,
    }
)

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "infra"
    / "modules"
    / "database-insights-lease-watchdog"
    / "restore_exact_monitoring_posture.py"
)
spec = importlib.util.spec_from_file_location("restore_exact_monitoring_posture", SCRIPT)
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)
restore.time.sleep = lambda seconds: None


POSTURE_VERSION = "rds-preserved-monitoring-posture-json-v1"


def preserved_posture(
    monitoring_interval=60,
    monitoring_role_arn=(
        "arn:aws:iam::135775632425:role/schoolpilot-production-rds-monitoring"
    ),
    exports=None,
):
    if exports is None:
        exports = ["postgresql", "upgrade"]
    posture = {
        "version": POSTURE_VERSION,
        "performanceInsightsKmsKeyId": "kms-key",
        "monitoringInterval": monitoring_interval,
        "monitoringRoleArn": monitoring_role_arn,
        "enabledCloudwatchLogsExports": exports,
    }
    raw = json.dumps(posture, separators=(",", ":"))
    return raw, hashlib.sha256(raw.encode("utf-8")).hexdigest()


def events(mode="manual", posture=None):
    posture_json, posture_sha256 = posture or preserved_posture()
    return {
        "dbInstanceIdentifier": "schoolpilot-production-db",
        "expectedDbInstanceArn": (
            "arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
        ),
        "expectedDatabaseResourceId": "db-JX7VX4P2ZHF5JXA6N5EREVL54I",
        "expectedDbInstanceClass": "db.t4g.medium",
        "expectedEngineVersion": "16.4",
        "preservedMonitoringPostureEncodingVersion": POSTURE_VERSION,
        "expectedPreservedMonitoringPostureJson": posture_json,
        "expectedPreservedMonitoringPostureSha256": posture_sha256,
        "restoreScheduleName": "db-insights-restore-e29866227184b29a3b050565",
        "restoreScheduleGroupName": "schoolpilot-production-db-insights-leases",
        "automationContractVersion": "ssm-rds-monitoring-restore-v2",
        "automationDocumentName": "schoolpilot-production-db-insights-restore-v2",
        "automationDocumentVersion": "1",
        "automationDocumentContentSha256": "a" * 64,
        "leaseIdSha256": "b" * 64,
        "expiresAtUtc": "2026-07-22T03:00:00.0000000+00:00",
        "restoreMode": mode,
        "maximumEventAgeInSeconds": 60,
    }


def bind_posture_json(bound_events, raw):
    bound_events["expectedPreservedMonitoringPostureJson"] = raw
    bound_events["expectedPreservedMonitoringPostureSha256"] = hashlib.sha256(
        raw.encode("utf-8")
    ).hexdigest()
    return bound_events


def exact_database(bound_events, mode="advanced"):
    posture = restore._parse_preserved_monitoring_posture(bound_events)
    return {
        "DBInstanceIdentifier": bound_events["dbInstanceIdentifier"],
        "DBInstanceArn": bound_events["expectedDbInstanceArn"],
        "DbiResourceId": bound_events["expectedDatabaseResourceId"],
        "DBInstanceClass": bound_events["expectedDbInstanceClass"],
        "DBInstanceStatus": "available",
        "Engine": "postgres",
        "EngineVersion": bound_events["expectedEngineVersion"],
        "DatabaseInsightsMode": mode,
        "PerformanceInsightsEnabled": True,
        "PerformanceInsightsRetentionPeriod": 7 if mode == "standard" else 465,
        "PerformanceInsightsKMSKeyId": posture["performanceInsightsKmsKeyId"],
        "MonitoringInterval": posture["monitoringInterval"],
        **(
            {"MonitoringRoleArn": posture["monitoringRoleArn"]}
            if posture["monitoringRoleArn"] is not None
            else {}
        ),
        "EnabledCloudwatchLogsExports": posture[
            "enabledCloudwatchLogsExports"
        ],
        "PendingModifiedValues": {},
        "DBParameterGroups": [{"ParameterApplyStatus": "in-sync"}],
    }


def exact_schedule(bound_events):
    expected = restore._expected_schedule(bound_events)
    return {
        "ActionAfterCompletion": "NONE",
        "Arn": expected["scheduleArn"],
        "CreationDate": datetime(2026, 7, 21, tzinfo=timezone.utc),
        "Description": expected["description"],
        "FlexibleTimeWindow": {"Mode": "OFF"},
        "GroupName": bound_events["restoreScheduleGroupName"],
        "LastModificationDate": datetime(2026, 7, 21, tzinfo=timezone.utc),
        "Name": bound_events["restoreScheduleName"],
        "ScheduleExpression": "rate(15 minutes)",
        "ScheduleExpressionTimezone": "UTC",
        "StartDate": restore._parse_schedule_time(bound_events["expiresAtUtc"]),
        "State": "ENABLED",
        "Target": copy.deepcopy(expected["target"]),
    }


class FakeRds:
    def __init__(self, bound_events, timeline, fail_modify=False, mode="advanced"):
        self.db = exact_database(bound_events, mode)
        self.timeline = timeline
        self.fail_modify = fail_modify
        self.modify_calls = 0

    def describe_db_instances(self, **kwargs):
        return {"DBInstances": [copy.deepcopy(self.db)]}

    def modify_db_instance(self, **kwargs):
        self.modify_calls += 1
        self.timeline.append("rds_modify_started_with_guard_enabled")
        if self.fail_modify:
            raise RuntimeError("simulated RDS failure")
        self.db["DatabaseInsightsMode"] = "standard"
        self.db["PerformanceInsightsRetentionPeriod"] = 7
        return {"DBInstance": copy.deepcopy(self.db)}


class ConcurrentRestoreFakeRds(FakeRds):
    """Models a scheduled restore winning a simultaneous manual RDS mutation."""

    def __init__(self, bound_events, timeline):
        super().__init__(bound_events, timeline)
        self.describe_calls_after_conflict = 0
        self.conflict_observed = False

    def describe_db_instances(self, **kwargs):
        if self.conflict_observed:
            self.describe_calls_after_conflict += 1
            if self.describe_calls_after_conflict >= 2:
                self.db["DBInstanceStatus"] = "available"
                self.db["DatabaseInsightsMode"] = "standard"
                self.db["PerformanceInsightsRetentionPeriod"] = 7
        return {"DBInstances": [copy.deepcopy(self.db)]}

    def modify_db_instance(self, **kwargs):
        self.modify_calls += 1
        self.timeline.append("manual_modify_collided_with_scheduled_restore")
        self.conflict_observed = True
        self.db["DBInstanceStatus"] = "modifying"
        raise ClientError("InvalidDBInstanceState")


class FakeScheduler:
    def __init__(
        self,
        schedule,
        timeline,
        delete_race=False,
        delete_conflict_after_peer_delete=False,
        update_conflict_after_peer_disable=False,
    ):
        self.schedule = copy.deepcopy(schedule)
        self.timeline = timeline
        self.delete_race = delete_race
        self.delete_conflict_after_peer_delete = delete_conflict_after_peer_delete
        self.update_conflict_after_peer_disable = update_conflict_after_peer_disable
        self.update_calls = 0
        self.delete_calls = 0

    def get_schedule(self, **kwargs):
        if self.schedule is None:
            raise ClientError("ResourceNotFoundException")
        return copy.deepcopy(self.schedule)

    def update_schedule(self, **kwargs):
        self.update_calls += 1
        self.timeline.append(
            "peer_schedule_disabled"
            if self.update_conflict_after_peer_disable
            else "schedule_disabled"
        )
        self.schedule.update(
            {
                "Description": kwargs["Description"],
                "ScheduleExpression": kwargs["ScheduleExpression"],
                "StartDate": kwargs["StartDate"],
                "ScheduleExpressionTimezone": kwargs["ScheduleExpressionTimezone"],
                "FlexibleTimeWindow": copy.deepcopy(kwargs["FlexibleTimeWindow"]),
                "Target": copy.deepcopy(kwargs["Target"]),
                "ActionAfterCompletion": kwargs["ActionAfterCompletion"],
                "State": kwargs["State"],
            }
        )
        if self.update_conflict_after_peer_disable:
            raise ClientError("ConflictException")
        return {"ScheduleArn": self.schedule["Arn"]}

    def delete_schedule(self, **kwargs):
        self.delete_calls += 1
        self.timeline.append("schedule_delete")
        self.schedule = None
        if self.delete_conflict_after_peer_delete:
            raise ClientError("ConflictException")
        if self.delete_race:
            raise ClientError("ResourceNotFoundException")
        return {}


class RestoreAutomationTests(unittest.TestCase):
    def run_handler(self, rds, scheduler, bound_events):
        restore.boto3.client = lambda name, config=None: {
            "rds": rds,
            "scheduler": scheduler,
        }[name]
        return restore.handler(bound_events, None)

    def test_standard_seven_absent_role_and_empty_exports_round_trip(self):
        bound = events(
            posture=preserved_posture(
                monitoring_interval=0,
                monitoring_role_arn=None,
                exports=[],
            )
        )
        expected = restore._parse_preserved_monitoring_posture(bound)
        self.assertEqual(expected["monitoringInterval"], 0)
        self.assertIsNone(expected["monitoringRoleArn"])
        self.assertEqual(expected["enabledCloudwatchLogsExports"], [])
        self.assertEqual(
            json.loads(restore._expected_schedule(bound)["target"]["Input"])[
                "Parameters"
            ]["ExpectedPreservedMonitoringPostureJson"],
            [bound["expectedPreservedMonitoringPostureJson"]],
        )

        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline)
        rds = FakeRds(bound, timeline)
        result = self.run_handler(rds, scheduler, bound)
        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])

    def test_enabled_monitoring_and_sorted_exports_round_trip(self):
        bound = events()
        expected = restore._parse_preserved_monitoring_posture(bound)
        self.assertEqual(expected["monitoringInterval"], 60)
        self.assertTrue(expected["monitoringRoleArn"].endswith("rds-monitoring"))
        self.assertEqual(
            expected["enabledCloudwatchLogsExports"], ["postgresql", "upgrade"]
        )

    def test_schedule_description_matches_powershell_lease_v3_contract(self):
        bound = events()
        expected = restore._expected_schedule(bound)
        binding_material = "|".join(
            (
                "135775632425",
                "us-east-1",
                bound["dbInstanceIdentifier"],
                bound["expiresAtUtc"],
                bound["leaseIdSha256"],
            )
        )
        binding_sha256 = hashlib.sha256(binding_material.encode("utf-8")).hexdigest()
        self.assertEqual(
            expected["description"],
            (
                "SchoolPilot db-insights restore v3 "
                f"lease={bound['leaseIdSha256']} binding={binding_sha256}"
            ),
        )
        powershell_source = (
            Path(__file__).resolve().parents[1]
            / "scripts"
            / "load"
            / "database-insights-lease.ps1"
        ).read_text(encoding="utf-8")
        self.assertIn('"SchoolPilot db-insights restore v3 lease=', powershell_source)
        self.assertNotIn('"SchoolPilot db-insights restore v2 lease=', powershell_source)

    def test_exact_schedule_uses_only_v2_posture_parameters(self):
        parameters = json.loads(restore._expected_schedule(events())["target"]["Input"])[
            "Parameters"
        ]
        self.assertEqual(
            parameters["PreservedMonitoringPostureEncodingVersion"],
            [POSTURE_VERSION],
        )
        self.assertEqual(
            parameters["ExpectedPreservedMonitoringPostureSha256"],
            [events()["expectedPreservedMonitoringPostureSha256"]],
        )
        for legacy_name in (
            "ExpectedPerformanceInsightsKmsKeyId",
            "ExpectedMonitoringInterval",
            "ExpectedMonitoringRoleArn",
            "ExpectedLogExportsJson",
        ):
            self.assertNotIn(legacy_name, parameters)

    def test_posture_rejects_hash_and_encoding_drift(self):
        bound = events()
        bound["expectedPreservedMonitoringPostureSha256"] = "0" * 64
        with self.assertRaisesRegex(RuntimeError, "hash did not match"):
            restore._parse_preserved_monitoring_posture(bound)

        bound = events()
        bound["preservedMonitoringPostureEncodingVersion"] = "legacy"
        with self.assertRaisesRegex(RuntimeError, "encoding version drifted"):
            restore._parse_preserved_monitoring_posture(bound)

        bound = events()
        bound["expectedPreservedMonitoringPostureSha256"] = "not-a-hash"
        with self.assertRaisesRegex(RuntimeError, "hash was malformed"):
            restore._parse_preserved_monitoring_posture(bound)

    def test_posture_rejects_malformed_duplicate_missing_and_extra_fields(self):
        malformed_values = (
            "{",
            (
                '{"version":"rds-preserved-monitoring-posture-json-v1",'
                '"version":"rds-preserved-monitoring-posture-json-v1",'
                '"performanceInsightsKmsKeyId":"kms-key",'
                '"monitoringInterval":0,"monitoringRoleArn":null,'
                '"enabledCloudwatchLogsExports":[]}'
            ),
            (
                '{"version":"rds-preserved-monitoring-posture-json-v1",'
                '"performanceInsightsKmsKeyId":"kms-key",'
                '"monitoringInterval":0,"monitoringRoleArn":null}'
            ),
            (
                '{"version":"rds-preserved-monitoring-posture-json-v1",'
                '"performanceInsightsKmsKeyId":"kms-key",'
                '"monitoringInterval":0,"monitoringRoleArn":null,'
                '"enabledCloudwatchLogsExports":[],"extra":true}'
            ),
        )
        for raw in malformed_values:
            with self.subTest(raw=raw):
                with self.assertRaisesRegex(RuntimeError, "malformed|fields"):
                    restore._parse_preserved_monitoring_posture(
                        bind_posture_json(events(), raw)
                    )

    def test_posture_rejects_noncanonical_json_and_body_version(self):
        posture_raw, _ = preserved_posture(
            monitoring_interval=0,
            monitoring_role_arn=None,
            exports=[],
        )
        with self.assertRaisesRegex(RuntimeError, "not canonical"):
            restore._parse_preserved_monitoring_posture(
                bind_posture_json(events(), posture_raw.replace(":", ": ", 1))
            )

        posture = json.loads(posture_raw)
        posture["version"] = "legacy"
        raw = json.dumps(posture, separators=(",", ":"))
        with self.assertRaisesRegex(RuntimeError, "body version drifted"):
            restore._parse_preserved_monitoring_posture(bind_posture_json(events(), raw))

    def test_posture_rejects_invalid_interval_role_and_kms_combinations(self):
        invalid_postures = (
            preserved_posture(0, "arn:aws:iam::135775632425:role/unexpected", []),
            preserved_posture(60, None),
            preserved_posture(2, None),
            preserved_posture(
                60,
                "arn:aws:iam::000000000000:role/cross-account-monitoring",
            ),
        )
        for posture in invalid_postures:
            with self.subTest(posture=posture[0]):
                with self.assertRaisesRegex(RuntimeError, "monitoring|role|interval"):
                    restore._parse_preserved_monitoring_posture(events(posture=posture))

        raw, _ = preserved_posture()
        posture = json.loads(raw)
        posture["performanceInsightsKmsKeyId"] = ""
        raw = json.dumps(posture, separators=(",", ":"))
        with self.assertRaisesRegex(RuntimeError, "KMS identity"):
            restore._parse_preserved_monitoring_posture(bind_posture_json(events(), raw))

    def test_posture_rejects_malformed_or_noncanonical_exports(self):
        for exports in (
            ["upgrade", "postgresql"],
            ["postgresql", "postgresql"],
            ["unsupported"],
            [1],
        ):
            with self.subTest(exports=exports):
                with self.assertRaisesRegex(RuntimeError, "log exports"):
                    restore._parse_preserved_monitoring_posture(
                        events(posture=preserved_posture(exports=exports))
                    )

    def test_legacy_automation_contract_and_document_are_rejected(self):
        bound = events()
        bound["automationContractVersion"] = "ssm-rds-monitoring-restore-v1"
        with self.assertRaisesRegex(RuntimeError, "contract version drifted"):
            self.run_handler(None, None, bound)

        bound = events()
        bound["automationDocumentName"] = "schoolpilot-production-db-insights-restore-v1"
        with self.assertRaisesRegex(RuntimeError, "document binding drifted"):
            restore._expected_schedule(bound)

    def test_failed_rds_restore_leaves_recurring_guard_enabled(self):
        bound = events()
        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline)
        rds = FakeRds(bound, timeline, fail_modify=True)
        with self.assertRaisesRegex(RuntimeError, "simulated RDS failure"):
            self.run_handler(rds, scheduler, bound)
        self.assertEqual(scheduler.schedule["State"], "ENABLED")
        self.assertEqual(scheduler.update_calls, 0)
        self.assertEqual(scheduler.delete_calls, 0)

    def test_scheduled_restore_converges_without_disarming_recurring_guard(self):
        bound = events("scheduled")
        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline)
        rds = FakeRds(bound, timeline)

        result = self.run_handler(rds, scheduler, bound)

        self.assertTrue(result["verified"])
        self.assertEqual(result["restoreMode"], "scheduled")
        self.assertNotIn("guardRemoved", result)
        self.assertEqual(scheduler.schedule["State"], "ENABLED")
        self.assertEqual(scheduler.update_calls, 0)
        self.assertEqual(scheduler.delete_calls, 0)

    def test_manual_restore_converges_before_disarm(self):
        bound = events()
        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline)
        rds = FakeRds(bound, timeline)
        result = self.run_handler(rds, scheduler, bound)
        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])
        self.assertLess(
            timeline.index("rds_modify_started_with_guard_enabled"),
            timeline.index("schedule_disabled"),
        )

    def test_guard_drift_is_terminal_not_successful_noop(self):
        bound = events("scheduled")
        timeline = []
        schedule = exact_schedule(bound)
        schedule["Target"]["SqsParameters"] = {}
        scheduler = FakeScheduler(schedule, timeline)
        rds = FakeRds(bound, timeline)
        with self.assertRaisesRegex(RuntimeError, "replaced or drifted"):
            self.run_handler(rds, scheduler, bound)
        self.assertEqual(rds.modify_calls, 0)

    def test_duplicate_schedule_target_key_is_guard_drift(self):
        bound = events("scheduled")
        timeline = []
        schedule = exact_schedule(bound)
        schedule["Target"]["Input"] = schedule["Target"]["Input"].replace(
            "{",
            '{"DocumentName":"schoolpilot-production-db-insights-restore-v1",',
            1,
        )
        scheduler = FakeScheduler(schedule, timeline)
        rds = FakeRds(bound, timeline)

        with self.assertRaisesRegex(RuntimeError, "replaced or drifted"):
            self.run_handler(rds, scheduler, bound)
        self.assertEqual(rds.modify_calls, 0)

    def test_overlapping_manual_delete_not_found_is_idempotent(self):
        bound = events()
        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline, delete_race=True)
        rds = FakeRds(bound, timeline, mode="standard")
        result = self.run_handler(rds, scheduler, bound)
        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])
        self.assertIsNone(scheduler.schedule)
        self.assertEqual(scheduler.delete_calls, 1)

    def test_overlapping_scheduled_and_manual_rds_restore_is_idempotent(self):
        bound = events("manual")
        timeline = []
        scheduler = FakeScheduler(exact_schedule(bound), timeline)
        rds = ConcurrentRestoreFakeRds(bound, timeline)

        result = self.run_handler(rds, scheduler, bound)

        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])
        self.assertEqual(rds.modify_calls, 1)
        self.assertIn("manual_modify_collided_with_scheduled_restore", timeline)
        self.assertIsNone(scheduler.schedule)

    def test_same_generation_overlapping_manual_disarm_is_idempotent(self):
        bound = events("manual")
        timeline = []
        scheduler = FakeScheduler(
            exact_schedule(bound),
            timeline,
            update_conflict_after_peer_disable=True,
        )
        rds = FakeRds(bound, timeline, mode="standard")

        result = self.run_handler(rds, scheduler, bound)

        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])
        self.assertEqual(scheduler.update_calls, 1)
        self.assertEqual(scheduler.delete_calls, 1)
        self.assertIn("peer_schedule_disabled", timeline)
        self.assertIsNone(scheduler.schedule)

    def test_same_generation_overlapping_manual_delete_conflict_is_idempotent(self):
        bound = events("manual")
        timeline = []
        schedule = exact_schedule(bound)
        schedule["State"] = "DISABLED"
        scheduler = FakeScheduler(
            schedule,
            timeline,
            delete_conflict_after_peer_delete=True,
        )
        rds = FakeRds(bound, timeline, mode="standard")

        result = self.run_handler(rds, scheduler, bound)

        self.assertTrue(result["verified"])
        self.assertTrue(result["guardRemoved"])
        self.assertEqual(scheduler.update_calls, 0)
        self.assertEqual(scheduler.delete_calls, 1)
        self.assertIsNone(scheduler.schedule)


if __name__ == "__main__":
    unittest.main()
