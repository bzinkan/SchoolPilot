# Reviewed rollout override, NOT the observed production baseline.
# Use with production.tfvars only in a separately reviewed saved plan/apply.
# Production remains at 100000 until that apply is verified and adopted.
#
# 2000 devices x (30 heartbeats + 60 observed screenshots) per 300 seconds
# = 180000 legitimate ingest operations behind a shared school egress IP.
# Leave headroom for navigation/recovery without changing per-device limits,
# WAF rule coverage, ordinary teacher API limits or task sizing.
waf_device_ingest_rate_limit = 300000
