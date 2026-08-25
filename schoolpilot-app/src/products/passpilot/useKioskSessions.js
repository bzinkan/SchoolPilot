import { useQuery } from "@tanstack/react-query";

import { useAuth } from "../../contexts/AuthContext";
import { queryClient } from "../../lib/queryClient";
import { passPilotClassRequest } from "./classData";

const KIOSK_SESSIONS_QUERY_KEY = ["passpilot", "kiosk-sessions"];

// Per-teacher kiosk sessions: the kiosk devices this teacher has claimed.
// Kiosks are teacher-bound (not school-global) — Send to Kiosk targets
// exactly this teacher's kiosks. A 404 from sessions/mine means the server
// predates kiosk sessions (deploy skew): callers fall back to the legacy
// school-global flow. The 15s poll keeps probing, so the UI upgrades itself
// once the server does.
export function useKioskSessions({ enabled = true } = {}) {
  const { user, activeSchoolId } = useAuth();
  const queryKey = [
    ...KIOSK_SESSIONS_QUERY_KEY,
    user?.id || "anonymous",
    activeSchoolId || "no-school",
  ];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const data = await passPilotClassRequest("GET", "/passpilot/kiosk/sessions/mine");
      if (!Array.isArray(data?.sessions)) {
        throw new Error("PassPilot returned an invalid kiosk-session response.");
      }
      return data;
    },
    enabled,
    refetchInterval: 15000,
    retry: (failureCount, error) =>
      error?.response?.status !== 404 && failureCount < 1,
  });

  const legacyKioskServer = query.error?.response?.status === 404;
  const kioskSessions = query.data?.sessions || [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey });

  // Bind an unclaimed kiosk (the 6-digit code on its screen) to this teacher.
  // classId is optional: without it the kiosk shows the teacher's name and
  // waits for Send to Kiosk. Throws on failure (404 = wrong/expired code).
  const claimKiosk = async ({ claimCode, classId = null }) => {
    const data = await passPilotClassRequest(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode, ...(classId ? { classId } : {}) }
    );
    invalidate();
    return data;
  };

  // Point ALL of this teacher's kiosks at a class. Returns { updated, sessions }.
  const retargetKiosks = async (classId) => {
    const data = await passPilotClassRequest(
      "POST",
      "/passpilot/kiosk/sessions/retarget",
      { classId }
    );
    if (
      !Array.isArray(data?.sessions)
      || !Number.isInteger(data?.updated)
      || data.updated !== data.sessions.length
      || data.sessions.some((session) => session?.classId !== classId)
    ) {
      throw new Error("PassPilot returned an invalid kiosk retarget response.");
    }
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData(queryKey, {
      sessions: data.sessions,
    });
    return data;
  };

  // Release one kiosk (it returns to its claim-code screen). Always refreshes
  // the list; rethrows so callers can distinguish 404 (already dead = fine).
  const releaseKiosk = async (sessionId) => {
    try {
      await passPilotClassRequest(
        "DELETE",
        `/passpilot/kiosk/sessions/${sessionId}`
      );
    } finally {
      invalidate();
    }
  };

  return {
    kioskSessions,
    legacyKioskServer,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    invalidate,
    claimKiosk,
    retargetKiosks,
    releaseKiosk,
  };
}
