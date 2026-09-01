import assert from "node:assert/strict";
import test from "node:test";
import { classpilotRestrictionAuthTransitionMetric } from
  "../src/services/classpilotRestrictionAuthMetrics.js";

test("restriction authentication transitions map to identifier-free counters", () => {
  assert.equal(
    classpilotRestrictionAuthTransitionMetric(null, "in_progress"),
    "restrictionAuthStarted"
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("in_progress", "returning"),
    null
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("returning", "complete"),
    "restrictionAuthCompleted"
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("returning", "idle"),
    null
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("in_progress", "idle"),
    null
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("in_progress", "timed_out"),
    "restrictionAuthTimedOut"
  );
  assert.equal(
    classpilotRestrictionAuthTransitionMetric("timed_out", "timed_out"),
    null
  );
});
