const SELECTED_CLASS_STORAGE_VERSION = "v1";
const SELECTED_CLASS_STORAGE_PREFIX = `passpilot:selected-class:${SELECTED_CLASS_STORAGE_VERSION}`;
const selectedClassCache = new Map();

export function passPilotSelectedClassStorageKey(userId, schoolId) {
  if (!userId || !schoolId) return null;
  return `${SELECTED_CLASS_STORAGE_PREFIX}:${encodeURIComponent(userId)}:${encodeURIComponent(schoolId)}`;
}

function getSessionStorage(storage) {
  if (storage) return storage;
  return globalThis.window?.sessionStorage ?? null;
}

export function readPassPilotSelectedClassId(userId, schoolId, storage) {
  const key = passPilotSelectedClassStorageKey(userId, schoolId);
  if (!key) return "";
  const useCache = storage === undefined;
  if (useCache && selectedClassCache.has(key)) return selectedClassCache.get(key);

  try {
    const value = getSessionStorage(storage)?.getItem(key);
    const classId = typeof value === "string" ? value : "";
    if (useCache) selectedClassCache.set(key, classId);
    return classId;
  } catch {
    return "";
  }
}

export function writePassPilotSelectedClassId(userId, schoolId, classId, storage) {
  const key = passPilotSelectedClassStorageKey(userId, schoolId);
  if (!key) return;
  const useCache = storage === undefined;
  if (useCache) {
    if (classId) selectedClassCache.set(key, classId);
    else selectedClassCache.delete(key);
  }

  try {
    const target = getSessionStorage(storage);
    if (!target) return;
    if (classId) target.setItem(key, classId);
    else target.removeItem(key);
  } catch {
    // Browsers can deny storage access. The in-memory value still preserves
    // selection for this SPA lifetime, while the URL remains authoritative.
  }
}

export function resolvePassPilotSelectedClassId(classes, requestedClassId, storedClassId) {
  const availableClassIds = new Set(classes.map((item) => item.id));
  if (requestedClassId && availableClassIds.has(requestedClassId)) return requestedClassId;
  if (storedClassId && availableClassIds.has(storedClassId)) return storedClassId;
  return classes[0]?.id || "";
}
