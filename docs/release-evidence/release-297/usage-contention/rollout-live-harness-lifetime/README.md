# Owned rollout harness lifetimes

Four mock fatal-case generators now remain alive through their monitor case, with actual process readiness, an atomic owner-release signal, and bounded cleanup. A successful rollback may already have contained its exact generator; normal live completion still requires exit0. Production monitoring and rollback behavior are unchanged.

Final local verification passed the lifecycle proof (15 assertions), failure-evidence proof (5), and the complete default AWS mock suite (380). The earlier helper assertion failure and all CI evidence remain preserved. Fresh final-head CI is required.

The original CI binding failure is proven; its precise subcause is unknown. The older204 monitor exception remains unexplained. No capacity or deployment approval is implied.
