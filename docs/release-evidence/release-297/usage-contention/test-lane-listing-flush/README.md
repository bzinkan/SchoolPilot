# Complete test-lane listing

The listing branch now waits for stdout to flush before exiting. On the exact Linux candidate image, the old runner failed the paused-reader regression and the corrected runner passed. The Windows baseline also passed, and remains recorded without a false red-test claim.

The existing governance test and new listing test passed9/9. Full unit and infrastructure evidence, source hashes, original failed CI logs, and bounded rollout artifacts are preserved separately in the manifest. The unrelated AWS fixture startup failure remains open. No application or production behavior changed.
