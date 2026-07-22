import copy
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


def events(mode="manual"):
    return {
        "dbInstanceIdentifier": "schoolpilot-production-db",
        "expectedDbInstanceArn": (
            "arn:aws:rds:us-east-1:135775632425:db:schoolpilot-production-db"
        ),
        "expectedDatabaseResourceId": "db-JX7VX4P2ZHF5JXA6N5EREVL54I",
        "expectedDbInstanceClass": "db.t4g.medium",
        "expectedEngineVersion": "16.4",
        "expectedPerformanceInsightsKmsKeyId": "kms-key",
        "expectedMonitoringInterval": "60",
        "expectedMonitoringRoleArn": "monitoring-role",
        "expectedLogExportsJson": '["postgresql","upgrade"]',
        "restoreScheduleName": "db-insights-restore-e29866227184b29a3b050565",
        "restoreScheduleGroupName": "schoolpilot-production-db-insights-leases",
        "automationDocumentName": "schoolpilot-production-db-insights-restore-v1",
        "automationDocumentVersion": "1",
        "automationDocumentContentSha256": "a" * 64,
        "leaseIdSha256": "b" * 64,
        "expiresAtUtc": "2026-07-22T03:00:00.0000000+00:00",
        "restoreMode": mode,
        "maximumEventAgeInSeconds": 60,
    }


def exact_database(bound_events, mode="advanced"):
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
        "PerformanceInsightsKMSKeyId": bound_events[
            "expectedPerformanceInsightsKmsKeyId"
        ],
        "MonitoringInterval": 60,
        "MonitoringRoleArn": bound_events["expectedMonitoringRoleArn"],
        "EnabledCloudwatchLogsExports": ["postgresql", "upgrade"],
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
