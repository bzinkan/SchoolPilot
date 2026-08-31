import { WebSocket } from "ws";
import { correlateClasspilotSessionMessage } from "../services/classpilotSessionSubscription.js";

export type WsRole = "teacher" | "office_staff" | "school_admin" | "super_admin" | "student";

export type WSClient = {
  ws: WebSocket;
  role: WsRole;
  deviceId?: string;
  studentId?: string;
  studentSessionId?: string;
  userId?: string;
  authVersion?: number;
  acceptedCapabilities?: string[];
  schoolId?: string;
  subscribedSessionIds: Set<string>;
  sessionSubscriptionEpochs: Map<string, number>;
  sessionSubscriptionIdentityGeneration: number;
  authenticated: boolean;
  passiveAuthorizationExpiresAt?: number;
  passiveAuthorizationGeneration?: number;
};

const wsClients = new Map<WebSocket, WSClient>();
const teacherSocketsBySchool = new Map<string, Set<WebSocket>>();
const studentSocketsBySchool = new Map<string, Set<WebSocket>>();

// Per-device message deduplication to prevent double delivery across Redis relay
const recentDeviceMessages = new Map<string, Set<string>>();
const DEDUP_TTL_MS = 10_000; // 10 seconds

function dedupKey(deviceId: string, msgId: string): boolean {
  const seen = recentDeviceMessages.get(deviceId);
  if (seen?.has(msgId)) return true; // already sent
  if (!seen) recentDeviceMessages.set(deviceId, new Set([msgId]));
  else seen.add(msgId);
  setTimeout(() => {
    const s = recentDeviceMessages.get(deviceId);
    if (s) { s.delete(msgId); if (s.size === 0) recentDeviceMessages.delete(deviceId); }
  }, DEDUP_TTL_MS);
  return false;
}

function extractMsgId(message: unknown): string | null {
  const msg = message as { _msgId?: string };
  return msg?._msgId ?? null;
}

function requiredStudentCapability(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const classroomState = (message as { classroomState?: unknown }).classroomState;
  if (!classroomState || typeof classroomState !== "object" || Array.isArray(classroomState)) {
    return null;
  }
  const deliveryContext = (classroomState as { deliveryContext?: unknown }).deliveryContext;
  if (!deliveryContext || typeof deliveryContext !== "object" || Array.isArray(deliveryContext)) {
    return null;
  }
  return (deliveryContext as { lateSignInRestrictionSso?: unknown })
    .lateSignInRestrictionSso === true
    ? "lateSignInRestrictionSsoV1"
    : null;
}

function addSocket(map: Map<string, Set<WebSocket>>, schoolId: string, ws: WebSocket) {
  const existing = map.get(schoolId);
  if (existing) {
    existing.add(ws);
    return;
  }
  map.set(schoolId, new Set([ws]));
}

function removeSocket(map: Map<string, Set<WebSocket>>, schoolId: string, ws: WebSocket) {
  const existing = map.get(schoolId);
  if (!existing) {
    return;
  }
  existing.delete(ws);
  if (existing.size === 0) {
    map.delete(schoolId);
  }
}

function isStaffRole(role: WsRole): boolean {
  return role === "teacher" || role === "office_staff" || role === "school_admin" || role === "super_admin";
}

export function registerWsClient(ws: WebSocket): WSClient {
  const client: WSClient = {
    ws,
    role: "student",
    subscribedSessionIds: new Set(),
    sessionSubscriptionEpochs: new Map(),
    sessionSubscriptionIdentityGeneration: 0,
    authenticated: false,
  };
  wsClients.set(ws, client);
  return client;
}

export function getWsClient(ws: WebSocket): WSClient | undefined {
  return wsClients.get(ws);
}

export function authenticateWsClient(
  ws: WebSocket,
  auth: {
    role: WsRole;
    schoolId: string;
    deviceId?: string;
    studentId?: string;
    studentSessionId?: string;
    userId?: string;
    authVersion?: number;
    acceptedCapabilities?: string[];
  }
): WSClient | undefined {
  const client = wsClients.get(ws);
  if (!client) {
    return undefined;
  }
  if (client.schoolId) {
    const map = client.role === "student" ? studentSocketsBySchool : teacherSocketsBySchool;
    removeSocket(map, client.schoolId, ws);
  }
  client.role = auth.role;
  client.schoolId = auth.schoolId;
  client.deviceId = auth.deviceId;
  client.studentId = auth.studentId;
  client.studentSessionId = auth.studentSessionId;
  client.userId = auth.userId;
  client.authVersion = auth.authVersion;
  client.acceptedCapabilities = auth.acceptedCapabilities ? [...auth.acceptedCapabilities] : [];
  client.authenticated = true;
  client.passiveAuthorizationExpiresAt = undefined;
  client.passiveAuthorizationGeneration = undefined;
  client.subscribedSessionIds.clear();
  client.sessionSubscriptionEpochs.clear();
  client.sessionSubscriptionIdentityGeneration += 1;

  if (auth.role === "student") {
    addSocket(studentSocketsBySchool, auth.schoolId, ws);
  } else {
    addSocket(teacherSocketsBySchool, auth.schoolId, ws);
  }

  return client;
}

export function removeWsClient(ws: WebSocket) {
  const client = wsClients.get(ws);
  if (client?.schoolId) {
    const map = client.role === "student" ? studentSocketsBySchool : teacherSocketsBySchool;
    removeSocket(map, client.schoolId, ws);
  }
  wsClients.delete(ws);
}

export function subscribeWsClientToSession(ws: WebSocket, sessionId: string): boolean {
  const client = wsClients.get(ws);
  if (!client || !client.authenticated || !isStaffRole(client.role)) {
    return false;
  }
  client.subscribedSessionIds.add(sessionId);
  return true;
}

export function unsubscribeWsClientFromSession(ws: WebSocket, sessionId: string): boolean {
  const client = wsClients.get(ws);
  if (!client || !client.authenticated || !isStaffRole(client.role)) {
    return false;
  }
  client.subscribedSessionIds.delete(sessionId);
  return true;
}

export function broadcastToTeachersLocal(schoolId: string, message: unknown): number {
  const sockets = teacherSocketsBySchool.get(schoolId);
  if (!sockets) {
    return 0;
  }
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || !client.authenticated || !isStaffRole(client.role)) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sentCount++;
    }
  });
  return sentCount;
}

export function isStaffUserConnectedLocal(schoolId: string, userId: string): boolean {
  const sockets = teacherSocketsBySchool.get(schoolId);
  if (!sockets) return false;
  for (const ws of sockets) {
    const client = wsClients.get(ws);
    if (
      client?.authenticated &&
      isStaffRole(client.role) &&
      client.userId === userId &&
      ws.readyState === WebSocket.OPEN
    ) {
      return true;
    }
  }
  return false;
}

export function sendToStaffUserLocal(schoolId: string, userId: string, message: unknown): number {
  const sockets = teacherSocketsBySchool.get(schoolId);
  if (!sockets) return 0;
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (
      !client?.authenticated ||
      !isStaffRole(client.role) ||
      client.userId !== userId ||
      ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    ws.send(messageStr);
    sentCount++;
  });
  return sentCount;
}

/** Close every local staff socket for one immutable user identity. */
export function closeStaffUserSocketsLocal(userId: string): number {
  let closedCount = 0;
  for (const [ws, client] of wsClients) {
    if (
      !client.authenticated ||
      !isStaffRole(client.role) ||
      client.userId !== userId
    ) {
      continue;
    }
    client.authenticated = false;
    removeWsClient(ws);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "auth-error",
        message: "Credentials have changed. Sign in again.",
        code: "CREDENTIAL_INVALIDATED",
      }));
      ws.close(1008, "Credentials invalidated");
    }
    closedCount += 1;
  }
  return closedCount;
}

export function broadcastToStaffSessionLocal(
  schoolId: string,
  sessionId: string,
  message: unknown
): number {
  const sockets = teacherSocketsBySchool.get(schoolId);
  if (!sockets) {
    return 0;
  }
  const messageStr = JSON.stringify(
    correlateClasspilotSessionMessage(sessionId, message)
  );
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || !client.authenticated || !isStaffRole(client.role)) {
      return;
    }
    if (!client.subscribedSessionIds.has(sessionId)) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sentCount++;
    }
  });
  return sentCount;
}

export function broadcastToStudentsLocal(
  schoolId: string,
  message: unknown,
  filterFn?: (client: WSClient) => boolean,
  targetDeviceIds?: string[]
): number {
  const sockets = studentSocketsBySchool.get(schoolId);
  if (!sockets) {
    return 0;
  }
  const msgId = extractMsgId(message);
  const messageStr = JSON.stringify(message);
  let sentCount = 0;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || client.role !== "student" || !client.authenticated) {
      return;
    }
    if (targetDeviceIds && targetDeviceIds.length > 0 && !targetDeviceIds.includes(client.deviceId ?? "")) {
      return;
    }
    // Per-device dedup: skip if this exact message was already sent to this device
    if (msgId && client.deviceId && dedupKey(client.deviceId, msgId)) {
      return;
    }
    if (!filterFn || filterFn(client)) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
        sentCount++;
      }
    }
  });
  return sentCount;
}

export function sendToDeviceLocal(schoolId: string, deviceId: string, message: unknown): boolean {
  const sockets = studentSocketsBySchool.get(schoolId);
  const msgType = (message as { type?: string })?.type ?? 'unknown';
  if (!sockets) {
    console.log(`[WS-Local] No exact-bound socket available for ${msgType}`);
    return false;
  }
  // Per-device dedup
  const msgId = extractMsgId(message);
  if (msgId && dedupKey(deviceId, msgId)) {
    return true;
  }
  const messageStr = JSON.stringify(message);
  let sent = false;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || !client.authenticated || client.deviceId !== deviceId) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
      sent = true;
      console.log(`[WS-Local] Sent exact-bound ${msgType}`);
    }
  });
  if (!sent) {
    console.log(`[WS-Local] Exact-bound local target unavailable for ${msgType}`);
  }
  return sent;
}

export type ExactStudentSocketBinding = {
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};

function validExactStudentSocketBinding(binding: ExactStudentSocketBinding): boolean {
  return [
    binding.schoolId,
    binding.studentId,
    binding.studentSessionId,
    binding.deviceId,
  ].every((value) => typeof value === "string" && value.length > 0 && value.length <= 256);
}

/**
 * Deliver only to the socket authenticated for one immutable student binding.
 * Redis delivery can run after the publishing transaction releases its
 * student-control lock, so a device-only lookup is insufficient after a
 * correct-PIN handoff reuses the same Chromebook.
 */
export function sendToStudentBindingLocal(
  binding: ExactStudentSocketBinding,
  message: unknown,
  options: { requiredCapability?: string } = {}
): boolean {
  const msgType = (message as { type?: string })?.type ?? "unknown";
  if (!validExactStudentSocketBinding(binding)) {
    console.log(`[WS-Local] Invalid exact student binding for ${msgType}`);
    return false;
  }
  const sockets = studentSocketsBySchool.get(binding.schoolId);
  if (!sockets) {
    console.log(`[WS-Local] No exact student-binding socket available for ${msgType}`);
    return false;
  }
  const requiredCapability = options.requiredCapability
    ?? requiredStudentCapability(message);
  const matchingSockets = [...sockets].filter((ws) => {
    const client = wsClients.get(ws);
    return client?.authenticated === true
      && client.role === "student"
      && client.deviceId === binding.deviceId
      && client.studentId === binding.studentId
      && client.studentSessionId === binding.studentSessionId
      && (
        !requiredCapability
        || client.acceptedCapabilities?.includes(requiredCapability) === true
      )
      && ws.readyState === WebSocket.OPEN;
  });
  if (matchingSockets.length === 0) {
    console.log(`[WS-Local] Exact student-binding target unavailable for ${msgType}`);
    return false;
  }
  const msgId = extractMsgId(message);
  if (msgId && dedupKey(`${binding.deviceId}:${binding.studentSessionId}`, msgId)) {
    return true;
  }
  const messageStr = JSON.stringify(message);
  for (const ws of matchingSockets) {
    ws.send(messageStr);
  }
  console.log(`[WS-Local] Sent exact student-binding ${msgType}`);
  return true;
}

export function sendToRoleLocal(schoolId: string, role: WsRole, message: unknown) {
  const sockets = role === "student" ? studentSocketsBySchool.get(schoolId) : teacherSocketsBySchool.get(schoolId);
  if (!sockets) {
    return;
  }
  const messageStr = JSON.stringify(message);
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (!client || client.role !== role || !client.authenticated) {
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(messageStr);
    }
  });
}

export function closeSocketsForSchool(schoolId: string) {
  const teacherSockets = teacherSocketsBySchool.get(schoolId);
  if (teacherSockets) {
    teacherSockets.forEach((ws) => ws.close());
    teacherSocketsBySchool.delete(schoolId);
  }
  const studentSockets = studentSocketsBySchool.get(schoolId);
  if (studentSockets) {
    studentSockets.forEach((ws) => ws.close());
    studentSocketsBySchool.delete(schoolId);
  }
}

/**
 * Immediately revoke every locally connected socket for selected students.
 * Remove registry authority before starting the close handshake so an
 * in-flight local broadcast cannot deliver another control to the stale
 * authenticated binding.
 */
export function closeStudentSocketsLocal(
  schoolId: string,
  studentIds: readonly string[]
): number {
  const sockets = studentSocketsBySchool.get(schoolId);
  if (!sockets || studentIds.length === 0) return 0;
  const targets = new Set(studentIds.map(String).filter(Boolean));
  if (targets.size === 0) return 0;

  let closed = 0;
  for (const ws of [...sockets]) {
    const client = wsClients.get(ws);
    if (
      !client?.authenticated ||
      client.role !== "student" ||
      !client.studentId ||
      !targets.has(client.studentId)
    ) {
      continue;
    }

    client.authenticated = false;
    sockets.delete(ws);
    wsClients.delete(ws);
    closed += 1;
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "auth-error",
          message: "Student session is no longer active",
        }));
      } catch {
        // The registry revocation above is already authoritative.
      }
      try {
        ws.close(1008, "Student session is no longer active");
      } catch {
        ws.terminate();
      }
    }
  }
  if (sockets.size === 0) studentSocketsBySchool.delete(schoolId);
  return closed;
}

export function getConnectedStudentDeviceIds(schoolId: string): Set<string> {
  const sockets = studentSocketsBySchool.get(schoolId);
  const deviceIds = new Set<string>();
  if (!sockets) return deviceIds;
  sockets.forEach((ws) => {
    const client = wsClients.get(ws);
    if (client?.authenticated && client.deviceId && ws.readyState === WebSocket.OPEN) {
      deviceIds.add(client.deviceId);
    }
  });
  return deviceIds;
}

export function resetWsState() {
  wsClients.clear();
  teacherSocketsBySchool.clear();
  studentSocketsBySchool.clear();
}
