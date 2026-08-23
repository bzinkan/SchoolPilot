import type { ClasspilotRealtimeStatus } from "./classpilotRealtimeStatus.js";

/** Protocol 3 exact-tab authority is accepted only from the repaired scoped
 * implementation. Archived protocol-2 snapshots retain their established V1
 * declaration path without version-string inference. */
export function classpilotExactTabCloseVersion(
  snapshot: Pick<
    ClasspilotRealtimeStatus,
    "clientProtocolVersion" | "acceptedCapabilities" | "extensionCapabilities"
  >
): 1 | 2 | null {
  if (snapshot.clientProtocolVersion === 3) {
    const accepted = new Set(snapshot.acceptedCapabilities || []);
    return accepted.has("scopedAuthorityChecksV1")
      && accepted.has("exactTabCloseV2")
      ? 2
      : null;
  }
  return new Set(snapshot.extensionCapabilities || []).has("exactTabCloseV1")
    ? 1
    : null;
}
