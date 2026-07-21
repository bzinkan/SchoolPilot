export const TILE_BATCH_POLL_ACCOUNTING_VERSION = "staggered-deadline-v1";

export function buildStaggeredPollAccounting(
  historyRequestsByCohort,
  screenshotRequestsByCohort,
  { expectedCohorts } = {},
) {
  if (!Array.isArray(historyRequestsByCohort) || !Array.isArray(screenshotRequestsByCohort)) {
    throw new TypeError("Tile poll accounting requires cohort arrays");
  }
  if (historyRequestsByCohort.length !== screenshotRequestsByCohort.length) {
    throw new Error("Tile poll accounting cohort arrays must have the same length");
  }
  if (expectedCohorts !== undefined && historyRequestsByCohort.length !== expectedCohorts) {
    throw new Error(`Tile poll accounting requires exactly ${expectedCohorts} cohorts`);
  }
  const history = historyRequestsByCohort.map((count) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("History cohort counts must be nonnegative integers");
    return count;
  });
  const screenshots = screenshotRequestsByCohort.map((count, index) => {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Screenshot cohort counts must be nonnegative integers");
    if (count !== history[index]) throw new Error("History and screenshot cohort counts must remain paired");
    return count;
  });
  const completeRoundsPerCohort = history.length > 0 ? Math.min(...history) : 0;
  const maximumRoundsPerCohort = history.length > 0 ? Math.max(...history) : 0;
  if (maximumRoundsPerCohort - completeRoundsPerCohort > 1) {
    throw new Error("Staggered cohort poll counts may differ by at most one");
  }
  const partialFinalRoundCohorts = history.filter((count) => count > completeRoundsPerCohort).length;
  if (history.some((count, index) => count !== (
    index < partialFinalRoundCohorts ? maximumRoundsPerCohort : completeRoundsPerCohort
  ))) {
    throw new Error("The partial final poll wave must be a leading stagger prefix");
  }
  return {
    pollAccountingVersion: TILE_BATCH_POLL_ACCOUNTING_VERSION,
    historyRequestsByCohort: history,
    screenshotRequestsByCohort: screenshots,
    completeRoundsPerCohort,
    maximumRoundsPerCohort,
    partialFinalRoundCohorts,
  };
}
