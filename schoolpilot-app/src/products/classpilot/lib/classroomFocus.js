// Classroom course scopes come only from the server review. Browser URLs and
// raw extension advertisements cannot establish that authority.
export function isClassroomFocusUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const raw = value.trim();
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port
      && url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') === 'classroom.google.com';
  } catch { return false; }
}

export function supportsClassroomFocus(student) {
  const accepted = student?.acceptedCapabilities ?? student?.capabilities;
  return ['scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1', 'classroomFocusScopeV1'].every(capability => (
    Array.isArray(student?.acceptedCapabilities) ? accepted.includes(capability) : accepted?.[capability] === true
  ));
}

export function classroomFocusReviewValid(value, now = Date.now()) {
  return value?.schemaVersion === 1 && value.purpose === 'classroom' && value.boundary === 'website'
    && typeof value.course?.id === 'string' && value.course.id.trim().length > 0
    && typeof value.course.name === 'string' && value.course.name.trim().length > 0
    && Number.isSafeInteger(value.itemCount) && value.itemCount >= 0
    && Number.isSafeInteger(value.linkCount) && value.linkCount >= 0
    && typeof value.reviewToken === 'string' && value.reviewToken.length > 0
    && Number.isFinite(value.expiresAt) && value.expiresAt > now
    && Array.isArray(value.scopes) && value.scopes.length > 0
    && Array.isArray(value.warnings) && Array.isArray(value.skipped) && value.skipped.length === 0
    && Array.isArray(value.effectiveAllowedDomains)
    && Array.isArray(value.authoring?.allowedDomains) && Array.isArray(value.authoring?.resources);
}

export function classroomFocusPayload(preview) {
  if (studentClassroomAccessReviewValid(preview, 'focus')) {
    return { url: 'https://classroom.google.com/', classroomAccess: { reviewToken: preview.reviewToken } };
  }
  if (!classroomFocusReviewValid(preview)) throw new Error('Review the current Classroom scope before setting Focus.');
  return { url: 'https://classroom.google.com/',
    classroomFocus: { courseId: preview.course.id, reviewToken: preview.reviewToken } };
}

export function studentClassroomAccessReviewValid(value, mode) {
  return value?.schemaVersion === 1 && value.purpose === 'student-classroom-access'
    && ['focus', 'flight-path', 'automatic-flight-path'].includes(value.mode) && value.mode === mode
    && Number.isSafeInteger(value.studentCount) && value.studentCount > 0
    && ['courseCount', 'itemCount', 'linkCount'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
    && typeof value.reviewToken === 'string' && value.reviewToken.length > 0
    && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now()
    && Array.isArray(value.scopes) && value.scopes.length > 0 && Array.isArray(value.warnings);
}

export function flightPathIncludesClassroom(path) {
  return (path?.allowedDomains || []).some(isClassroomFocusUrl)
    || (path?.resources || []).some(resource => resource?.type === 'website' && isClassroomFocusUrl(resource.hostname));
}

export function classroomFlightPathPayload(path, preview) {
  if (!path?.id || typeof path.updatedAt !== 'string' || !Number.isFinite(Date.parse(path.updatedAt))
    || !studentClassroomAccessReviewValid(preview, 'flight-path')) {
    throw new Error('Review the current Flight Path and Classroom access again before applying.');
  }
  return { flightPathId: path.id, expectedFlightPathUpdatedAt: path.updatedAt,
    classroomAccess: { reviewToken: preview.reviewToken } };
}
