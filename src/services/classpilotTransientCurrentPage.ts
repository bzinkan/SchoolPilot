import type { ClasspilotRestrictionAuthPassThroughEnvelope } from "./classpilotClassroomState.js";

export function classpilotTransientCurrentPageCommandEnvelope(options: {
  currentPage?: boolean;
  restrictionExpiresAt?: Date;
  authPassThrough?: ClasspilotRestrictionAuthPassThroughEnvelope;
}): Record<string, unknown> {
  if (!options.currentPage) return {};
  return {
    currentPage: true,
    ...(options.restrictionExpiresAt
      ? { restrictionExpiresAt: options.restrictionExpiresAt.toISOString() }
      : {}),
    ...(options.authPassThrough
      ? { authPassThrough: options.authPassThrough }
      : {}),
  };
}
