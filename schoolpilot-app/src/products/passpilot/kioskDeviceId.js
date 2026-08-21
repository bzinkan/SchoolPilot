// Durable kiosk-device identity (pp_kiosk_device), sent as X-Kiosk-Device on
// kiosk session bootstrap/resume so the server can remember which teacher
// runs kiosks on this physical device.
//
// ALWAYS localStorage — deliberately including launch=gate mode. The gate
// rule in kioskPinStore exists to keep the staff PIN out of a shared student
// profile; this id is a non-secret opaque UUID that grants nothing without
// the school kiosk PIN (it only selects WHICH teacher's kiosk a PIN-holder
// can resume), and persisting it is exactly what makes next-morning resume
// work on shared devices. One shared key for both kiosk pages: one physical
// device, one identity.
//
// Page-load fallback: the URL param is stripped after the first bootstrap,
// so an adopted id must survive later bootstrap re-fires (retries, session
// expiry) even when localStorage writes are blocked.
let inMemoryDeviceId = null;

// try/catch → the in-memory id (or null): storage-blocked browsers keep the
// adopted identity for this page load and only lose cross-load persistence.
export function getKioskDeviceId() {
  try {
    let id = window.localStorage.getItem("pp_kiosk_device");
    if (!id) {
      id = inMemoryDeviceId || crypto.randomUUID();
      window.localStorage.setItem("pp_kiosk_device", id);
    }
    inMemoryDeviceId = id;
    return id;
  } catch {
    return inMemoryDeviceId;
  }
}

const KIOSK_DEVICE_ID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Adopt a device id delivered by the ClassPilot extension via ?device= on the
// kiosk launch URL. Managed Chromebooks derive it from the device's permanent
// enrollment identity, so it survives the profile wipes that erase
// localStorage overnight — it always wins over a locally minted random id.
// Returns { id, previousId } (previousId = the stored id this adoption
// replaced, so the bootstrap can prove same-device continuity to the server),
// or null when the candidate is not UUID-shaped.
export function adoptKioskDeviceId(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (!KIOSK_DEVICE_ID_SHAPE.test(trimmed)) return null;
  const normalized = trimmed.toLowerCase();
  let previousId = null;
  try {
    const stored = window.localStorage.getItem("pp_kiosk_device");
    if (stored && stored !== normalized) previousId = stored;
  } catch {
    if (inMemoryDeviceId && inMemoryDeviceId !== normalized) {
      previousId = inMemoryDeviceId;
    }
  }
  inMemoryDeviceId = normalized;
  try {
    window.localStorage.setItem("pp_kiosk_device", normalized);
  } catch {
    // Storage-blocked: inMemoryDeviceId carries the adoption for this page
    // load; it just will not persist across loads.
  }
  return { id: normalized, previousId };
}
