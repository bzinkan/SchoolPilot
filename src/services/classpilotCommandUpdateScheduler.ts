type ClasspilotCommandUpdateScheduler = (schoolId: string, commandId: string) => void;

let activeScheduler: ClasspilotCommandUpdateScheduler | null = null;

export function registerClasspilotCommandUpdateScheduler(
  scheduler: ClasspilotCommandUpdateScheduler | null
): void {
  activeScheduler = scheduler;
}

/** Route accepted HTTP and WebSocket ACKs through one ordered/coalesced path. */
export function scheduleClasspilotCommandUpdate(schoolId: string, commandId: string): boolean {
  if (!activeScheduler) return false;
  activeScheduler(schoolId, commandId);
  return true;
}
