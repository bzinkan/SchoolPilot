export function isClassPilotWebSocketPath(pathname: string): boolean {
  return pathname === "/ws" || pathname === "/ws/";
}

export function isGoPilotSocketIoPath(pathname: string): boolean {
  return pathname === "/gopilot-socket" || pathname === "/gopilot-socket/";
}
