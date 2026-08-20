import { useQuery } from "@tanstack/react-query";

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
  const query = useQuery({
    queryKey: KIOSK_SESSIONS_QUERY_KEY,
    queryFn: () => passPilotClassRequest("GET", "/passpilot/kiosk/sessions/mine"),
    enabled,
    refetchInterval: 15000,
    retry: (failureCount, error) =>
      error?.response?.status !== 404 && failureCount < 1,
  });

  const legacyKioskServer = query.error?.response?.status === 404;
  const kioskSessions = query.data?.sessions || [];

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: KIOSK_SESSIONS_QUERY_KEY });

  // Bind an unclaimed kiosk (the 6-digit code on its screen) to this teacher
  // and a class. Throws on failure (404 = wrong/expired code).
  const claimKiosk = async ({ claimCode, classId }) => {
    const data = await passPilotClassRequest(
      "POST",
      "/passpilot/kiosk/sessions/claim",
      { claimCode, classId }
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
    invalidate();
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
    invalidate,
    claimKiosk,
    retargetKiosks,
    releaseKiosk,
  };
}
