const KIOSK_SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Display only. The server still verifies the exact session and its owner.
export function kioskLightPairingCode(sessionId) {
  return typeof sessionId === 'string' && KIOSK_SESSION_UUID.test(sessionId)
    ? sessionId.slice(-6).toUpperCase()
    : '';
}
