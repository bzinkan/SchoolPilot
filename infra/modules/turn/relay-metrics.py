#!/usr/bin/env python3
"""Publish aggregate coturn metrics without exporting log identities."""

import json
import os
import re
import subprocess
import sys

LOG_PATH = "/var/log/turnserver/turn.log"
STATE_PATH = "/var/lib/classpilot-turn-metrics/state.json"
MAX_ACTIVE_ALLOCATIONS = 2_048
SESSION_PATTERN = re.compile(r"\bsession ([0-9]{1,32}):")
ALLOCATION_PATTERN = re.compile(r"\bALLOCATE processed, success\b")
AUTHENTICATION_FAILURE_PATTERN = re.compile(
    r"\b(?:Cannot find credentials|credentials are incorrect)\b",
    re.IGNORECASE,
)
USAGE_PATTERN = re.compile(r": usage: .*?\brb=(\d+)\b.*\bsb=(\d+)\b")
CLOSED_PATTERN = re.compile(r": closed(?:\s|\()")


def sanitized_allocations(raw):
    values = []
    if isinstance(raw, list):
        for value in raw[-MAX_ACTIVE_ALLOCATIONS:]:
            candidate = str(value)
            if re.fullmatch(r"[0-9]{1,32}", candidate):
                values.append(candidate)
    return values


def read_state():
    try:
        with open(STATE_PATH, "r", encoding="ascii") as handle:
            state = json.load(handle)
        inode = int(state.get("inode", 0))
        offset = int(state.get("offset", 0))
        if inode < 0 or offset < 0:
            raise ValueError("negative state")
        return inode, offset, sanitized_allocations(state.get("activeAllocations"))
    except (FileNotFoundError, OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0, 0, []


def write_state(inode, offset, active_allocations):
    temporary = STATE_PATH + ".tmp"
    with open(temporary, "w", encoding="ascii") as handle:
        json.dump({
            "inode": inode,
            "offset": offset,
            "activeAllocations": list(active_allocations)[-MAX_ACTIVE_ALLOCATIONS:],
        }, handle, separators=(",", ":"))
    os.chmod(temporary, 0o600)
    os.replace(temporary, STATE_PATH)


def parse_lines(lines, existing_allocations):
    active = dict.fromkeys(sanitized_allocations(existing_allocations))
    relay_bytes = 0
    allocation_count = 0
    authentication_failure_count = 0
    for line in lines:
        if AUTHENTICATION_FAILURE_PATTERN.search(line):
            authentication_failure_count += 1
        session_match = SESSION_PATTERN.search(line)
        if not session_match:
            continue
        session_id = session_match.group(1)
        if ALLOCATION_PATTERN.search(line):
            allocation_count += 1
            active.pop(session_id, None)
            while len(active) >= MAX_ACTIVE_ALLOCATIONS:
                active.pop(next(iter(active)))
            active[session_id] = None
        usage_match = USAGE_PATTERN.search(line)
        if usage_match and session_id in active:
            # The client-side usage row already covers both relay directions.
            # Excluding `peer usage` prevents counting the same bytes twice.
            relay_bytes += int(usage_match.group(1)) + int(usage_match.group(2))
        if CLOSED_PATTERN.search(line):
            active.pop(session_id, None)
    return relay_bytes, allocation_count, authentication_failure_count, list(active)


def publish_metrics(relay_bytes, allocation_count, authentication_failure_count):
    if relay_bytes <= 0 and allocation_count <= 0 and authentication_failure_count <= 0:
        return
    region = os.environ.get("AWS_REGION", "")
    namespace = os.environ.get("METRIC_NAMESPACE", "")
    if not re.fullmatch(r"[a-z0-9-]{3,32}", region):
        raise RuntimeError("invalid AWS region")
    if not re.fullmatch(r"[A-Za-z0-9/_.-]{1,255}", namespace):
        raise RuntimeError("invalid metric namespace")
    metric_data = []
    if relay_bytes > 0:
        metric_data.append({
            "MetricName": "RelayBytes",
            "Unit": "Bytes",
            "Value": relay_bytes,
        })
    if allocation_count > 0:
        metric_data.append({
            "MetricName": "AllocationCount",
            "Unit": "Count",
            "Value": allocation_count,
        })
    if authentication_failure_count > 0:
        metric_data.append({
            "MetricName": "AuthenticationFailureCount",
            "Unit": "Count",
            "Value": authentication_failure_count,
        })
    encoded_metric_data = json.dumps(metric_data, separators=(",", ":"))
    subprocess.run([
        "aws", "cloudwatch", "put-metric-data",
        "--region", region,
        "--namespace", namespace,
        "--metric-data", encoded_metric_data,
        "--no-cli-pager",
    ], check=True, timeout=30)


def collect():
    try:
        stat = os.stat(LOG_PATH)
    except FileNotFoundError:
        return
    prior_inode, prior_offset, allocations = read_state()
    offset = prior_offset if prior_inode == stat.st_ino and prior_offset <= stat.st_size else 0
    with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as handle:
        handle.seek(offset)
        relay_bytes, allocation_count, authentication_failure_count, active = parse_lines(
            handle,
            allocations,
        )
        next_offset = handle.tell()
    # Advance only after CloudWatch accepts the metric so a transient AWS
    # failure retries the same aggregate instead of silently losing it.
    publish_metrics(relay_bytes, allocation_count, authentication_failure_count)
    write_state(stat.st_ino, next_offset, active)


def self_test():
    # Sanitized rows captured from the Ubuntu 24.04 coturn 4.6.1-1build4
    # package in an isolated loopback relay test. Keep the elapsed-seconds
    # prefix and message grammar aligned with that integration fixture; all
    # identities and addresses below are synthetic.
    lines = [
        "1: : session 000000000000000001: realm <synthetic> user <>: incoming packet message processed, error 401: Unauthorized\n",
        "1: : ERROR: check_stun_auth: user synthetic credentials are incorrect\n",
        "2: : session 000000000000000002: realm <synthetic> user <opaque>: incoming packet ALLOCATE processed, success\n",
        "8: : session 000000000000000002: usage: realm=<synthetic>, username=<opaque>, rp=2, rb=120, sp=3, sb=240\n",
        "8: : session 000000000000000002: peer usage: realm=<synthetic>, username=<opaque>, rp=3, rb=240, sp=2, sb=120\n",
        "8: : session 000000000000000002: closed (2nd stage), user <opaque> realm <synthetic> origin <>, local 127.0.0.1:3478, remote 127.0.0.1:50000, reason: allocation timeout\n",
    ]
    relay_bytes, allocations, authentication_failures, active = parse_lines(lines, [])
    assert relay_bytes == 360
    assert allocations == 1
    assert authentication_failures == 1
    assert active == []
    assert sanitized_allocations(["bad", "1", "2"]) == ["1", "2"]


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    elif sys.argv[1:]:
        raise SystemExit("unsupported arguments")
    else:
        collect()
