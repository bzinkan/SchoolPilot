# Retained record of the separately reviewed 2,000-device rollout override.
# Applied and verified 2026-11-10; production.tfvars now records the same observed
# 300000 baseline. This file is no longer an outstanding activation step.
#
# 2000 devices x (30 heartbeats + 60 observed screenshots) per 300 seconds
# = 180000 legitimate ingest operations behind a shared school egress IP.
# Leave headroom for navigation/recovery without changing per-device limits,
# WAF rule coverage, ordinary teacher API limits or task sizing.
waf_device_ingest_rate_limit = 300000
