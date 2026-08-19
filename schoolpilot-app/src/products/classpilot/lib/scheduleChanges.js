import { apiRequest, queryClient } from "../../../lib/queryClient";

const ROOT = "classpilot-schedule-changes";

export const scheduleChangeKeys = {
  root: (schoolId) => [ROOT, schoolId || "no-school"],
  settings: (schoolId) => [ROOT, schoolId || "no-school", "settings"],
  pairs: (schoolId) => [ROOT, schoolId || "no-school", "pairs"],
  classes: (schoolId) => [ROOT, schoolId || "no-school", "classes"],
  eligibility: (schoolId, scheduledDate) => [
    ROOT,
    schoolId || "no-school",
    "eligibility",
    scheduledDate || "no-date",
  ],
  list: (schoolId, scope) => [ROOT, schoolId || "no-school", "list", scope],
  today: (schoolId) => [ROOT, schoolId || "no-school", "today"],
};

export function scheduleChangeError(error, fallback = "The schedule change could not be saved.") {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || fallback;
}

export function isRevisionConflict(error) {
  return error?.response?.status === 409;
}

export function unwrapSettings(data) {
  const settings = data?.settings ?? data ?? {};
  return {
    teacherRequestsEnabled: settings.teacherRequestsEnabled === true,
    adminApprovalRequired: settings.adminApprovalRequired !== false,
    sameDayCutoffEnforced: settings.sameDayCutoffEnforced !== false,
    sameDayCutoff: settings.sameDayCutoff || "07:00",
    reasonRequired: settings.reasonRequired !== false,
    schoolTimezone: settings.schoolTimezone || null,
    revision: Number.isInteger(settings.revision) ? settings.revision : 0,
  };
}

export function unwrapPairs(data) {
  return Array.isArray(data) ? data : data?.pairs ?? [];
}

export function unwrapEligibility(data) {
  const pairs = data?.eligiblePairs ?? data?.pairs ?? [];
  return {
    eligiblePairs: pairs.filter((pair) => pair?.eligible !== false),
    pairs,
    policy: unwrapSettings(data?.policy ?? data?.settings ?? {}),
    date: data?.scheduledDate ?? data?.date ?? null,
    schoolTimezone: data?.schoolTimezone ?? null,
  };
}

export function unwrapChanges(data) {
  const changes = Array.isArray(data) ? data : data?.changes ?? [];
  return changes.map((change) => ({
    ...change,
    scheduledDate: change.scheduledDate ?? change.date,
  }));
}

export function unwrapToday(data) {
  const changes = Array.isArray(data)
    ? data
    : Array.isArray(data?.changes)
      ? data.changes
      : data?.change ? [data.change] : [];
  return changes.map((change) => ({
    ...change,
    scheduledDate: change.scheduledDate ?? change.date ?? data?.scheduledDate,
  }));
}

export function changeLegs(change) {
  return change?.legs ?? change?.scheduleLegs ?? [];
}

export function pairClasses(pair) {
  if (Array.isArray(pair?.classes)) return pair.classes;
  const first = pair?.firstClass ?? pair?.classA ?? pair?.leftClass;
  const second = pair?.secondClass ?? pair?.classB ?? pair?.rightClass;
  return [first, second].filter(Boolean);
}

export function classId(value) {
  return value?.groupId ?? value?.classId ?? value?.class?.id ?? value?.id ?? "";
}

export function className(value) {
  return value?.className ?? value?.class?.name ?? value?.name ?? "Class";
}

export function teacherName(value) {
  return value?.teacherName
    ?? value?.primaryTeacherName
    ?? value?.primaryTeacher?.name
    ?? value?.primaryTeacher?.displayName
    ?? value?.teacher?.displayName
    ?? "Teacher";
}

export function originalWindow(value) {
  const window = value?.normalWindow ?? value?.originalWindow ?? value?.class?.normalWindow ?? {};
  return {
    start: window.start ?? window.startTime ?? value?.originalStartTime ?? value?.blockStartTime ?? value?.startTime ?? "",
    end: window.end ?? window.endTime ?? value?.originalEndTime ?? value?.blockEndTime ?? value?.endTime ?? "",
  };
}

export function effectiveWindow(value) {
  const window = value?.effectiveWindow ?? value?.swappedWindow ?? {};
  return {
    start: window.start ?? window.startTime ?? value?.effectiveStartTime ?? value?.swappedStartTime ?? value?.destinationStartTime ?? "",
    end: window.end ?? window.endTime ?? value?.effectiveEndTime ?? value?.swappedEndTime ?? value?.destinationEndTime ?? "",
  };
}

export function pairPreviewLegs(pair) {
  if (Array.isArray(pair?.preview)) return pair.preview;
  if (Array.isArray(pair?.preview?.legs)) return pair.preview.legs;
  const classes = pairClasses(pair);
  if (classes.length !== 2) return [];
  const firstWindow = originalWindow(classes[0]);
  const secondWindow = originalWindow(classes[1]);
  return [
    {
      ...classes[0],
      originalStartTime: firstWindow.start,
      originalEndTime: firstWindow.end,
      effectiveStartTime: secondWindow.start,
      effectiveEndTime: secondWindow.end,
    },
    {
      ...classes[1],
      originalStartTime: secondWindow.start,
      originalEndTime: secondWindow.end,
      effectiveStartTime: firstWindow.start,
      effectiveEndTime: firstWindow.end,
    },
  ];
}

export function allowedActions(change) {
  return Array.isArray(change?.allowedActions) ? change.allowedActions : [];
}

export function formatSchoolDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return date || "Date not available";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00.000Z`));
}

export function formatTime(time) {
  if (!/^\d{1,2}:\d{2}/.test(time || "")) return time || "—";
  const [hours, minutes] = time.slice(0, 5).split(":").map(Number);
  const suffix = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 || 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

export function formatWindow(window) {
  return `${formatTime(window.start)}–${formatTime(window.end)}`;
}

export function schoolLocalDate(timeZone = "America/New_York", date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function invalidateScheduleChanges(schoolId) {
  return queryClient.invalidateQueries({ queryKey: scheduleChangeKeys.root(schoolId) });
}

export const scheduleChangeApi = {
  getSettings: () => apiRequest("GET", "/classpilot/schedule-changes/settings"),
  updateSettings: (payload) => apiRequest("PATCH", "/classpilot/schedule-changes/settings", payload),
  getPairs: () => apiRequest("GET", "/classpilot/schedule-changes/pairs"),
  createPair: (payload) => apiRequest("POST", "/classpilot/schedule-changes/pairs", payload),
  deletePair: (pairId, expectedRevision) => apiRequest(
    "DELETE",
    `/classpilot/schedule-changes/pairs/${pairId}`,
    { expectedRevision },
  ),
  getEligibility: (scheduledDate) => apiRequest(
    "GET",
    `/classpilot/schedule-changes/eligibility?date=${encodeURIComponent(scheduledDate)}`,
  ),
  getChanges: (scope) => apiRequest(
    "GET",
    `/classpilot/schedule-changes?scope=${encodeURIComponent(scope)}`,
  ),
  getToday: () => apiRequest("GET", "/classpilot/schedule-changes/today"),
  createChange: (payload) => apiRequest("POST", "/classpilot/schedule-changes", payload),
  actOnChange: (changeId, action, expectedRevision) => apiRequest(
    "POST",
    `/classpilot/schedule-changes/${changeId}/actions`,
    { action, expectedRevision },
  ),
};
