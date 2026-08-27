export function advanceGraceReconciliationLatch(current, scopeKey, reconnectingStudentIds) {
  const hasReconnectingStudents = Array.from(reconnectingStudentIds || []).length > 0;
  const sameScope = current?.scopeKey === scopeKey;
  const cohortActive = sameScope && current?.cohortActive === true;

  if (!hasReconnectingStudents) {
    return {
      latch: { scopeKey, cohortActive: false },
      shouldRefetch: false,
    };
  }
  if (cohortActive) {
    return {
      latch: current,
      shouldRefetch: false,
    };
  }
  return {
    latch: { scopeKey, cohortActive: true },
    shouldRefetch: true,
  };
}

export function reconcileGraceCohort({
  current,
  scopeKey,
  reconnectingStudentIds,
  reconciliationInFlight = false,
  refetch,
}) {
  const decision = advanceGraceReconciliationLatch(
    current,
    scopeKey,
    reconnectingStudentIds,
  );
  if (
    decision.shouldRefetch
    && !reconciliationInFlight
    && typeof refetch === 'function'
  ) {
    refetch();
  }
  return decision.latch;
}
