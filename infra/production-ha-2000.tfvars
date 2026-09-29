# ============================================================================
# Production HA Scale-Up Profile
# ============================================================================
#
# Use these values when broad ClassPilot onboarding is ready to resume and the
# 500/1,000/2,000 active-device load gate is being prepared.

project     = "schoolpilot"
environment = "production"
aws_region  = "us-east-1"

# Networking
vpc_cidr                    = "10.1.0.0/16"
az_count                    = 2
ecs_tasks_in_public_subnets = false
enable_nat_gateway          = true

# Database — standard HA posture for the 2,000 active-device gate
db_instance_class        = "db.t4g.large"
db_multi_az              = true
db_allocated_storage     = 100
db_max_allocated_storage = 1000
db_name                  = "schoolpilot"
db_username              = "schoolpilot"

# Redis
redis_node_type     = "cache.t4g.small"
redis_replica_count = 1

# ECS — scheduler work runs in the singleton worker, so the API can scale out safely.
# Never below the reviewed production sizes in production.tfvars (API 1 vCPU /
# 2 GiB, worker 0.5 vCPU / 1 GiB); a scale-up profile must not shrink tasks.
ecs_desired_count           = 2
enable_api_arrival_capacity = false
ecs_cpu                     = 1024
ecs_memory                  = 2048
worker_desired_count        = 1
worker_cpu                  = 512
worker_memory               = 1024
db_pool_max                 = 20
scheduler_db_pool_max       = 5
enable_container_insights   = true

# Shared-school-IP WAF capacity remains compatible with the launch profile.
waf_api_rate_limit           = 50000
waf_device_ingest_rate_limit = 100000
waf_rate_rule_action         = "block"

# Domain — auto-creates ACM cert, DNS records, and derives app URLs
# Accessible at school-pilot.net + www.school-pilot.net
domain                  = "school-pilot.net"
google_client_id        = "562964657318-l7k0b7iuh0e16m88nqqvngs83eh3ddki.apps.googleusercontent.com"
route53_measure_latency = true

# Alerts
alerts_sns_topic_arn = "arn:aws:sns:us-east-1:135775632425:schoolpilot-production-alerts"

# Existing SecureString parameters for optional runtime secrets that must not
# remain as plaintext ECS task environment values.
anthropic_api_key_parameter_arn  = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/ANTHROPIC_API_KEY"
gemini_api_key_parameter_arn     = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/GEMINI_API_KEY"
telegram_bot_token_parameter_arn = "arn:aws:ssm:us-east-1:135775632425:parameter/schoolpilot/production/TELEGRAM_BOT_TOKEN"

# Legacy ClassPilot TURN (built for the retired Live View architecture) is
# PARKED. enable_classpilot_turn = true means Terraform retains the TURN
# infrastructure; it does not mean TURN runs, that Live View is a product
# feature, or that Present to Class will reuse these nodes. Both nodes are
# stopped to remove idle EC2 cost; Elastic IPs, DNS, secret, security group and
# IAM are retained for rollback. See docs/CLASSPILOT_TURN_PARKING.md.
# Supply the sensitive Let's Encrypt contact only through the private
# TF_VAR_classpilot_turn_tls_email process environment whenever a new saved
# plan is created; saved-plan apply does not reread it. Never commit the address
# to this file.
# This profile carries the same three TURN inputs as production.tfvars, and
# they move together: omitting enable_classpilot_turn plans a destroy of the
# whole TURN module, and enabling it without the parked flag and pinned image
# would start both nodes and replace them on a newer image. Because TURN is
# enabled here, every plan from this profile needs
# TF_VAR_classpilot_turn_tls_email set to the address already in production
# state: the turn_activation_gate precondition fails without it, and a
# different address changes the node user data, which prevent_destroy stops.
enable_classpilot_turn = true
classpilot_turn_parked = true
# Verified on both nodes on 2026-09-28: Canonical
# ubuntu-noble-24.04-amd64-server-20260714 (owner 099720109477).
classpilot_turn_ami_id = "ami-052355af2a014bd2c"
