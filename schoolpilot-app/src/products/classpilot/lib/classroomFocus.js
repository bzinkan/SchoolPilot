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
  if (!classroomFocusReviewValid(preview)) throw new Error('Review the current Classroom scope before setting Focus.');
  return { url: 'https://classroom.google.com/',
    classroomFocus: { courseId: preview.course.id, reviewToken: preview.reviewToken } };
}
