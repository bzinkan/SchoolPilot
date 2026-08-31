// Durable, school-scoped kiosk continuity identity, sent as X-Kiosk-Device on
// kiosk session bootstrap/resume so the server can remember which teacher
// runs kiosks on this physical device without making the browser linkable
// across schools.
//
// ALWAYS localStorage — deliberately including launch=gate mode. The gate
// rule in kioskPinStore exists to keep the staff PIN out of a shared student
// profile; this id is a non-secret opaque UUID that grants nothing without
// the school kiosk PIN (it only selects WHICH teacher's kiosk a PIN-holder
// can resume), and persisting it is exactly what makes next-morning resume
// work on shared devices. Both kiosk pages share one key per school.
//
// Page-load fallback: the URL param is stripped after the first bootstrap,
// so an adopted id must survive later bootstrap re-fires (retries, session
// expiry) even when localStorage writes are blocked.
const LEGACY_DEVICE_KEY = "pp_kiosk_device";
const inMemoryDeviceIds = new Map();
const inMemoryPreviousDeviceIds = new Map();
let pendingLaunchTicket = null;

function normalizedSchoolScope(schoolId) {
  return String(schoolId || "").trim();
}

function storageKey(schoolId) {
  const scope = normalizedSchoolScope(schoolId);
  return scope ? `${LEGACY_DEVICE_KEY}:${scope}` : LEGACY_DEVICE_KEY;
}

function readStoredDeviceId(schoolId) {
  const scope = normalizedSchoolScope(schoolId);
  const key = storageKey(scope);
  let id = window.localStorage.getItem(key);
  if (!id && scope) {
    // Move the pre-2.7 global id into the first school that opens it. Removing
    // the old key prevents a second school from inheriting the same value.
    id = window.localStorage.getItem(LEGACY_DEVICE_KEY);
    if (id) {
      window.localStorage.setItem(key, id);
      window.localStorage.removeItem(LEGACY_DEVICE_KEY);
    }
  }
  return id;
}

// try/catch → the in-memory id (or null): storage-blocked browsers keep the
// adopted identity for this page load and only lose cross-load persistence.
export function getKioskDeviceId(schoolId) {
  const scope = normalizedSchoolScope(schoolId);
  try {
    let id = readStoredDeviceId(scope);
    if (!id) {
      id = inMemoryDeviceIds.get(scope) || crypto.randomUUID();
      window.localStorage.setItem(storageKey(scope), id);
    }
    inMemoryDeviceIds.set(scope, id);
    return id;
  } catch {
    return inMemoryDeviceIds.get(scope) || null;
  }
}

const KIOSK_DEVICE_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Adopt an opaque school-scoped continuity id returned after launch-ticket
// redemption. The legacy ?device= path remains readable during the protocol-v2
// compatibility window, but new clients never place a stable id in the URL.
// Returns { id, previousId } (previousId = the stored id this adoption
// replaced, so the bootstrap can prove same-device continuity to the server),
// or null when the candidate is not UUID-shaped.
export function adoptKioskDeviceId(candidate, schoolId) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!KIOSK_DEVICE_ID_SHAPE.test(trimmed)) return null;
  const scope = normalizedSchoolScope(schoolId);
  const normalized = trimmed.toLowerCase();
  let previousId = null;
  try {
    const stored = readStoredDeviceId(scope);
    if (stored && stored !== normalized) previousId = stored;
  } catch {
    const inMemory = inMemoryDeviceIds.get(scope);
    if (inMemory && inMemory !== normalized) {
      previousId = inMemory;
    }
  }
  inMemoryDeviceIds.set(scope, normalized);
  if (previousId) inMemoryPreviousDeviceIds.set(scope, previousId);
  try {
    window.localStorage.setItem(storageKey(scope), normalized);
  } catch {
    // Storage-blocked: in-memory state carries the adoption for this page
    // load; it just will not persist across loads.
  }
  return { id: normalized, previousId: inMemoryPreviousDeviceIds.get(scope) || null };
}

export function getKioskDeviceAdoption(schoolId) {
  const scope = normalizedSchoolScope(schoolId);
  const id = getKioskDeviceId(scope);
  return id ? { id, previousId: inMemoryPreviousDeviceIds.get(scope) || null } : null;
}

export function confirmKioskDeviceAdoption(deviceId, schoolId) {
  const scope = normalizedSchoolScope(schoolId);
  if (deviceId && deviceId === inMemoryDeviceIds.get(scope)) {
    inMemoryPreviousDeviceIds.delete(scope);
  }
}

// Read the one-use launch ticket from the fragment and remove it synchronously
// so it never survives in copied URLs, browser history, or later navigation.
// The module-scoped copy makes React StrictMode's repeated initializer safe;
// it is cleared as soon as redemption reaches a terminal response.
export function takeKioskLaunchTicket() {
  try {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const candidate = fragment.get('launchTicket');
    if (candidate) {
      pendingLaunchTicket = candidate.length <= 4096 ? candidate : null;
      fragment.delete('launchTicket');
      const remaining = fragment.toString();
      window.history.replaceState(
        {},
        '',
        `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`,
      );
    }
  } catch {
    pendingLaunchTicket = null;
  }
  return pendingLaunchTicket;
}

export function forgetKioskLaunchTicket(ticket) {
  if (ticket && pendingLaunchTicket === ticket) pendingLaunchTicket = null;
}

// Gate-launched kiosks can be exited before launch-ticket redemption settles.
// Clear the module-scoped capability and scrub any fragment copy without
// touching the durable, non-secret kiosk continuity id in localStorage.
export function discardKioskLaunchTicket() {
  pendingLaunchTicket = null;
  try {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    if (!fragment.has('launchTicket')) return;
    fragment.delete('launchTicket');
    const remaining = fragment.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`,
    );
  } catch {
    // Navigation still proceeds; the next document cannot retain module state.
  }
}

export function isKioskLaunchTicketPending(ticket) {
  return Boolean(ticket && pendingLaunchTicket === ticket);
}
