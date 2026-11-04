import type { ClasspilotSafetyAction } from "./classpilotSafetyAction.js";
import crypto from "node:crypto";
import { classpilotControlStateExactBinding } from "./classpilotControlStateFrame.js";
import { classpilotSchoolPolicyAuthorityEnvelope } from "./classpilotCommandAuthority.js";
import { classpilotCommandDeliveryPolicy, classpilotCommandExpiresAt } from "./classpilotCommandDelivery.js";

type SafetyCloseInput = {
  action: ClasspilotSafetyAction;
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
  expectedControlRevision: number;
  deliveredControlRevision: number;
};
type SafetyCloseTarget = {
  kind: "student-binding";
  schoolId: string;
  studentId: string;
  studentSessionId: string;
  deviceId: string;
};
type SafetyCloseDependencies = {
  withAuthority(input: SafetyCloseInput, send: (binding: { controlRevision: number }) => void): Promise<unknown>;
  sendLocal(target: SafetyCloseTarget, frame: unknown): boolean;
  publishRemote(target: SafetyCloseTarget, frame: unknown): Promise<boolean>;
};

/** A successful result means a close was requested, never that the client
 * confirmed closure. Each observation gets a new transient request, independent
 * of case merging, notification delivery and evidence availability. */
export async function dispatchClasspilotSafetyClose(
  input: SafetyCloseInput, dependencies?: SafetyCloseDependencies,
): Promise<boolean> {
  const { action, schoolId, studentId, studentSessionId, deviceId } = input;
  if (!action.closeTabData
    || action.snapshot.schoolId !== schoolId || action.snapshot.studentId !== studentId
    || action.snapshot.studentSessionId !== studentSessionId || action.snapshot.deviceId !== deviceId
    || !Number.isSafeInteger(input.expectedControlRevision) || input.expectedControlRevision < 0
    || !Number.isSafeInteger(input.deliveredControlRevision) || input.deliveredControlRevision < 0) return false;

  if (!dependencies) {
    const [storage, tenant, local, remote] = await Promise.all([
      import("./storage.js"), import("../middleware/tenantContext.js"),
      import("../realtime/ws-broadcast.js"), import("../realtime/ws-redis.js"),
    ]);
    dependencies = {
      withAuthority: (options, send) => tenant.runWithTenantContext(
        { schoolId: options.schoolId, operation: "heartbeat_background" },
        () => storage.revalidateClasspilotSafetyExactBinding({ ...options, classifiedUrl: options.action.classifiedUrl }, send),
      ),
      sendLocal: local.sendToStudentBindingLocal,
      publishRemote: remote.publishWS,
    };
  }
  const transport = dependencies;
  const target: SafetyCloseTarget = { kind: "student-binding", schoolId, studentId, studentSessionId, deviceId };
  let localSent = false;
  let publication = Promise.resolve(false);
  await transport.withAuthority(input, ({ controlRevision }) => {
    const exact = action.exactTabCloseVersion === 2
      ? { exactBinding: classpilotControlStateExactBinding({ ...target, controlRevision }) } : {};
    const deliveryPolicy = classpilotCommandDeliveryPolicy("close-tab");
    const expiresAt = classpilotCommandExpiresAt("close-tab", new Date())!.toISOString();
    const frame = {
      type: "remote-control", _msgId: crypto.randomUUID(),
      studentId, studentSessionId, ...exact, deliveryPolicy, expiresAt,
      command: {
        type: "close-tab", studentId, studentSessionId, ...exact, deliveryPolicy, expiresAt,
        ...classpilotSchoolPolicyAuthorityEnvelope(schoolId, "ai_safety"),
        data: { ...action.closeTabData, studentId, studentSessionId },
      },
    };
    // Both transports are initiated under the same authority lock. A failed
    // socket must not prevent the exact-bound relay from reaching another task.
    try { localSent = transport.sendLocal(target, frame); } catch { /* try relay */ }
    try { publication = transport.publishRemote(target, frame).catch(() => false); } catch { /* no broad fallback */ }
  });
  const remoteSent = await publication;
  return localSent || remoteSent;
}
