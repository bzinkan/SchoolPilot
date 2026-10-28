const ADMIN_CLASS_SORT_VALUES = new Set(["name", "teacher", "grade", "time"]);

function browserStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

export function adminClassSortStorageKey(schoolId, userId) {
  if (!schoolId || !userId) return null;
  return `classpilot-admin-classes-sort:v1:${encodeURIComponent(schoolId)}:${encodeURIComponent(userId)}`;
}

export function readAdminClassSortPreference(key, storage = browserStorage()) {
  if (!key || !storage) return "name";
  try {
    const value = storage.getItem(key);
    return ADMIN_CLASS_SORT_VALUES.has(value) ? value : "name";
  } catch {
    return "name";
  }
}

export function writeAdminClassSortPreference(key, value, storage = browserStorage()) {
  if (!key || !storage || !ADMIN_CLASS_SORT_VALUES.has(value)) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function displayedStartMinutes(group) {
  if (group?.scheduleEnabled !== true || !group.blockStartTime || !group.blockEndTime) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(group.blockStartTime);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function sortAdminClassesByTime(classes) {
  return [...(classes || [])].sort((left, right) => {
    const leftStart = displayedStartMinutes(left);
    const rightStart = displayedStartMinutes(right);
    if (leftStart === null && rightStart !== null) return 1;
    if (leftStart !== null && rightStart === null) return -1;
    if (leftStart !== null && rightStart !== null && leftStart !== rightStart) return leftStart - rightStart;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
}
