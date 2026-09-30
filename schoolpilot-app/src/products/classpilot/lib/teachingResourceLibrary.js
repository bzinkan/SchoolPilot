// School Library view models for Flight Paths and Block Lists.
//
// The server decides who may see, share, mark official, edit or copy an item
// (the School Library rollout is school-scoped and off by default). These
// helpers only read what the list responses already carry: `library` and
// `features.sharedTeachingResources` are present only while the library is on
// for the school, so an absent `features` key always means "off".

const EMPTY = Object.freeze([]);

/**
 * Normalizes a GET /flight-paths or GET /block-lists response.
 * key is 'flightPaths' or 'blockLists'.
 */
export function teachingResourceList(data, key) {
  const own = Array.isArray(data) ? data : Array.isArray(data?.[key]) ? data[key] : EMPTY;
  const libraryEnabled = !Array.isArray(data) && data?.features?.sharedTeachingResources === true;
  const library = libraryEnabled && Array.isArray(data?.library) ? data.library : EMPTY;
  return { own, library, libraryEnabled };
}

/** "Official" outranks "Shared"; private items have no badge. */
export function teachingResourceBadge(item) {
  if (item?.official === true) return 'Official';
  if (item?.visibility === 'school') return 'Shared';
  return null;
}

/**
 * Dashboard selectors: the teacher's own items first (unchanged order), then
 * School Library items, each carrying a badge. An id is listed once.
 */
export function mergeTeachingResourceOptions(data, key) {
  const { own, library } = teachingResourceList(data, key);
  if (library.length === 0) return own;
  const seen = new Set(own.map((item) => item?.id));
  const merged = [...own];
  for (const item of library) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push({ ...item, fromSchoolLibrary: true });
  }
  return merged;
}

/**
 * Allowed domains of the Flight Path a student is actually on, for the
 * off-task hint.
 *
 * Without School Library items in the list (the library is off) this is the
 * previous behavior: the teacher's own Flight Path with the active name. With
 * library items present, names can collide (an own item and a shared item may
 * share a name), so the classroom state's applied domains win, then a match by
 * Flight Path id when one is known, and a name is used only when exactly one
 * item carries it.
 */
export function activeFlightPathAllowedDomains(student, flightPaths = EMPTY) {
  const activeName = String(student?.activeFlightPathName || '').trim();
  if (!flightPaths.some((candidate) => candidate?.fromSchoolLibrary === true)) {
    if (!activeName) return EMPTY;
    return flightPaths.find((candidate) => candidate?.flightPathName === activeName)?.allowedDomains || EMPTY;
  }
  const snapshot = student?.classroomState?.restrictions?.flightPath;
  if (snapshot?.active === true && Array.isArray(snapshot.allowedDomains) && snapshot.allowedDomains.length > 0) {
    return snapshot.allowedDomains;
  }
  const activeId = String(snapshot?.id || student?.activeFlightPathId || '').trim();
  if (activeId) return flightPaths.find((candidate) => candidate?.id === activeId)?.allowedDomains || EMPTY;
  if (!activeName) return EMPTY;
  const named = flightPaths.filter((candidate) => candidate?.flightPathName === activeName);
  return named.length === 1 ? named[0].allowedDomains || EMPTY : EMPTY;
}

/** Server error text when present (403/409 explain themselves), else the generic message. */
export function teachingResourceErrorMessage(error) {
  return error?.response?.data?.error || error?.message || 'Request failed';
}
