// Storage backend for the kiosk PIN (pp_kiosk_pin).
//
// launch=gate: the kiosk was opened from a locked ClassPilot Chromebook's
// auth gate (shared student device). The staff PIN must die with the tab,
// so use sessionStorage and never touch the student profile's localStorage.
// Normal kiosk setups keep localStorage so a dedicated device survives
// reboots without re-entering the PIN.
//
// Evaluated at call time (not module scope) so a lazily loaded chunk can't
// capture a stale decision.
export function kioskPinStore() {
  return new URLSearchParams(window.location.search).get("launch") === "gate"
    ? window.sessionStorage
    : window.localStorage;
}
