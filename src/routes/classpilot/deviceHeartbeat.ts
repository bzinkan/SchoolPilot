export interface PendingMessage {
  id: string;
  message: string;
}

export function shouldAcceptHeartbeat(
  lastHeartbeatByDevice: Map<string, number>,
  deviceId: string,
  now = Date.now(),
  minIntervalMs = 5_000
): boolean {
  const lastHeartbeatAt = lastHeartbeatByDevice.get(deviceId);
  if (lastHeartbeatAt !== undefined && now - lastHeartbeatAt < minIntervalMs) {
    return false;
  }

  lastHeartbeatByDevice.set(deviceId, now);
  return true;
}

export async function getPendingMessagesForFirstHeartbeat(options: {
  deliveredMessagesByDevice: Map<string, Set<string>>;
  deviceId: string;
  studentId: string;
  loadRecentMessages: (studentId: string, limit: number) => Promise<PendingMessage[]>;
  limit?: number;
}): Promise<PendingMessage[]> {
  const {
    deliveredMessagesByDevice,
    deviceId,
    studentId,
    loadRecentMessages,
    limit = 5,
  } = options;

  if (deliveredMessagesByDevice.has(deviceId)) return [];

  const recent = await loadRecentMessages(studentId, limit);
  const delivered = new Set<string>();
  deliveredMessagesByDevice.set(deviceId, delivered);

  const pendingMessages = recent.map((m) => ({ id: m.id, message: m.message }));
  for (const message of pendingMessages) delivered.add(message.id);
  return pendingMessages;
}

export function buildHeartbeatResponse(
  planStatus?: string | null,
  pendingMessages: PendingMessage[] = []
) {
  return {
    ok: true,
    planStatus: planStatus || "active",
    ...(pendingMessages.length > 0 ? { pendingMessages } : {}),
  };
}
