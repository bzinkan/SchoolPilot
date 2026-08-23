export type ClasspilotControlStateFrameBinding = {
  schoolId: string;
  deviceId: string;
  studentId: string;
  studentSessionId: string;
  controlRevision: number;
};

export function classpilotControlStateExactBinding(
  binding: ClasspilotControlStateFrameBinding
) {
  if (!Number.isSafeInteger(binding.controlRevision) || binding.controlRevision < 0) {
    throw new Error("ClassPilot control state revision is invalid");
  }
  return {
    bindingVersion: 2 as const,
    schoolId: binding.schoolId,
    deviceId: binding.deviceId,
    studentId: binding.studentId,
    studentSessionId: binding.studentSessionId,
    controlRevision: binding.controlRevision,
  };
}

export function classpilotClassroomStatePushFrame<T>(options: {
  type: "classroom-state" | "classroom-state-sync";
  messageId?: string;
  binding: ClasspilotControlStateFrameBinding;
  classroomState: T;
}) {
  return {
    type: options.type,
    ...(options.messageId ? { _msgId: options.messageId } : {}),
    studentId: options.binding.studentId,
    studentSessionId: options.binding.studentSessionId,
    exactBinding: classpilotControlStateExactBinding(options.binding),
    classroomState: options.classroomState,
  };
}

export function classpilotFabStatePushFrame<T>(options: {
  messageId: string;
  sessionId?: string;
  binding: ClasspilotControlStateFrameBinding;
  data: T;
}) {
  return {
    type: "fab-state-sync" as const,
    _msgId: options.messageId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    exactBinding: classpilotControlStateExactBinding(options.binding),
    data: options.data,
  };
}
