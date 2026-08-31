export const CLASSPILOT_CURRENT_PAGE_SIGNED_OUT_SKIP_REASON =
  "current_page_requires_online_student";

export function classpilotCurrentPageSignedOutSkipReason(options: {
  currentPageRequested: boolean;
  explicitlySignedOut: boolean;
}): string | undefined {
  return options.currentPageRequested && options.explicitlySignedOut
    ? CLASSPILOT_CURRENT_PAGE_SIGNED_OUT_SKIP_REASON
    : undefined;
}

export function countClasspilotCurrentPageSignedOutSkips(
  targets: ReadonlyArray<{ unavailableReason?: string | null }>
): number {
  return targets.filter((target) =>
    target.unavailableReason === CLASSPILOT_CURRENT_PAGE_SIGNED_OUT_SKIP_REASON
  ).length;
}
