/**
 * Labels which server-authoritative input produced a screenshot authority's
 * `authorityStartedAt`. Diagnostic only: the value is exactly the unlabeled
 * max() the authority projections used before, and the label never takes part
 * in an authority check. It lets the upload fence count which input restarted
 * the capture window behind a `before_authority` rejection.
 *
 * This module stays dependency-free so the unit lane can exercise it without
 * loading the storage layer.
 */
export type ClasspilotScreenshotAuthorityStartSource =
  | "student_session_started"
  | "teaching_start_time"
  | "roster_snapshot_completed"
  | "control_updated";

export type ClasspilotScreenshotAuthorityStartInput = readonly [
  source: ClasspilotScreenshotAuthorityStartSource,
  value: Date | null | undefined,
];

export type LabeledClasspilotAuthorityStart = {
  value: Date;
  source: ClasspilotScreenshotAuthorityStartSource | undefined;
};

/**
 * The latest non-null input wins. Ties resolve to the earlier-listed input, so
 * callers list inputs in precedence order. With no usable input the start is
 * the epoch and carries no label, matching the previous unlabeled fold.
 */
export function latestLabeledClasspilotAuthorityStart(
  ...inputs: ClasspilotScreenshotAuthorityStartInput[]
): LabeledClasspilotAuthorityStart {
  let value = new Date(0);
  let source: ClasspilotScreenshotAuthorityStartSource | undefined;
  for (const [candidateSource, candidate] of inputs) {
    if (candidate && candidate > value) {
      value = candidate;
      source = candidateSource;
    }
  }
  return { value, source };
}
