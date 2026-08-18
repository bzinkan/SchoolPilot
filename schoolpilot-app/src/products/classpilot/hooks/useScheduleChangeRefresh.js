import { useEffect } from "react";

import { invalidateScheduleChanges } from "../lib/scheduleChanges";

const REALTIME_TYPES = new Set([
  "schedule-change-updated",
  "classpilot-schedule-change-updated",
]);

export function useScheduleChangeRefresh({ schoolId, token, currentUser, enabled = true }) {
  useEffect(() => {
    if (!enabled || !schoolId) return undefined;

    const refresh = () => {
      void invalidateScheduleChanges(schoolId);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };

    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [enabled, schoolId]);

  useEffect(() => {
    if (!enabled || !schoolId || !token || !currentUser?.id) return undefined;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
    let heartbeatId = null;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "auth",
        userToken: token,
        userId: currentUser.id,
        schoolId,
        role: ["admin", "school_admin"].includes(currentUser.role)
          ? "school_admin"
          : currentUser.role === "office_staff"
            ? "office_staff"
            : "teacher",
      }));
      heartbeatId = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      }, 20_000);
    });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "auth-success" || REALTIME_TYPES.has(message.type)) {
          void invalidateScheduleChanges(schoolId);
        }
      } catch {
        // Ignore malformed realtime frames; polling and focus refresh remain active.
      }
    });

    return () => {
      if (heartbeatId) window.clearInterval(heartbeatId);
      socket.close();
    };
  }, [currentUser?.id, currentUser?.role, enabled, schoolId, token]);
}
