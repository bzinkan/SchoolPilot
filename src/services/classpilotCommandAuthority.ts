export type ClasspilotCommandAuthority = {
  teachingSessionId: string | null;
  supervisionContextId: string | null;
};

/**
 * Additive extension command authority contract. Values must come from the
 * persisted command header, never from a current dashboard selection.
 */
export function classpilotCommandAuthorityEnvelope(command: {
  teachingSessionId?: string | null;
  supervisionContextId?: string | null;
}) {
  const teachingSessionId = command.teachingSessionId || null;
  const supervisionContextId = command.supervisionContextId || null;
  return {
    authority: {
      teachingSessionId,
      supervisionContextId,
    } satisfies ClasspilotCommandAuthority,
    // Compatibility aliases for consumers that cannot yet read `authority`.
    teachingSessionId,
    supervisionContextId,
  };
}

export type ClasspilotSchoolPolicyAuthoritySource = "ai_safety" | "school_settings";

export function classpilotSchoolPolicyAuthorityEnvelope(
  schoolId: string,
  source: ClasspilotSchoolPolicyAuthoritySource
) {
  return {
    authority: {
      kind: "school_policy" as const,
      schoolId,
      source,
    },
  };
}
