export function normalizedObservationScope(scope) {
  if (scope?.kind === 'class') return { kind: 'class' };
  if (scope?.kind !== 'students' || !Array.isArray(scope.studentIds)) return null;
  const studentIds = [...new Set(scope.studentIds.filter(Boolean).map(String))].sort();
  return studentIds.length > 0 && studentIds.length <= 500
    ? { kind: 'students', studentIds }
    : null;
}

export function observationLeaseFailureStatus(error) {
  const responseStatus = Number(error?.response?.status);
  const responseCode = typeof error?.response?.data?.code === 'string'
    ? error.response.data.code
    : null;

  if (
    !responseStatus
    || responseStatus === 408
    || responseStatus === 429
    || responseStatus >= 500
    || responseCode === 'OBSERVATION_LEASE_UNAVAILABLE'
  ) {
    return 'error';
  }
  return 'denied';
}

export function observationLeaseRenewalFailureDisposition(error) {
  const status = observationLeaseFailureStatus(error);
  return {
    status,
    releaseLease: status === 'denied',
  };
}

export function observationLeaseResponseDisposition({
  stopped,
  requestEpoch,
  currentEpoch,
  visibilityState,
  requestViewerId,
  activeViewerId,
}) {
  return !stopped
    && requestEpoch === currentEpoch
    && visibilityState === 'visible'
    && requestViewerId === activeViewerId
    ? 'adopt'
    : 'release';
}
