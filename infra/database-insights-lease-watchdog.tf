# ============================================================================
# Database Insights monitoring lease -- durable restoration watchdog
# ============================================================================
#
# The diagnostic/certification controller temporarily enables Database
# Insights Advanced. A local detached watchdog handles the normal path, while
# this AWS Scheduler control survives loss or reboot of the operator host. The
# lease helper creates one dynamic recurring guard in this pre-provisioned
# group before it is allowed to mutate the production RDS instance. Non-
# production environments intentionally do not receive this medium-only
# certification control.

module "database_insights_lease_watchdog" {
  count  = var.environment == "production" ? 1 : 0
  source = "./modules/database-insights-lease-watchdog"

  name_prefix                = local.name
  aws_region                 = var.aws_region
  aws_account_id             = data.aws_caller_identity.current.account_id
  db_instance_arn            = "arn:aws:rds:${var.aws_region}:${data.aws_caller_identity.current.account_id}:db:${local.name}-db"
  expected_db_instance_class = "db.t4g.medium"
  alerts_sns_topic_arn       = var.alerts_sns_topic_arn
}
