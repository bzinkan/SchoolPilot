import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ArrowLeft, Bath, Heart, Triangle, Clock } from "lucide-react";
import { isCanonicalPassPilotSource, PASSPILOT_CLASS_MODEL_HEADER } from "../classData";
import KioskOfflineBanner from "../components/KioskOfflineBanner";
import {
  createKioskApiClient,
  KioskRequestError,
  kioskSnapshotRevision,
  normalizeKioskSnapshot,
  redeemKioskLaunchTicket,
} from "../kioskController";
import { kioskPinStore } from "../kioskPinStore";
import {
  adoptKioskDeviceId,
  confirmKioskDeviceAdoption,
  forgetKioskLaunchTicket,
  getKioskDeviceAdoption,
  getKioskDeviceId,
  isKioskLaunchTicketPending,
  takeKioskLaunchTicket,
} from "../kioskDeviceId";
import { useKioskPollingController } from "../useKioskPollingController";

const DESTINATIONS = [
  { value: "bathroom", label: "General/Restroom", icon: Bath, color: "text-blue-400" },
  { value: "nurse", label: "Nurse", icon: Heart, color: "text-red-400" },
  { value: "office", label: "Office", icon: Triangle, color: "text-yellow-400" },
];

const DESTINATION_PICKER_TIMEOUT = 10000; // 10 seconds - auto-close destination picker

function getTimeSince(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min";
  return `${mins} min`;
}

function getDestinationLabel(dest, custom) {
  if (custom) return custom;
  const found = DESTINATIONS.find(d => d.value === dest);
  if (found) return found.label;
  const lower = dest.toLowerCase();
  if (lower.includes("bathroom") || lower.includes("restroom") || lower.includes("general")) return "General/Restroom";
  if (lower.includes("nurse")) return "Nurse";
  if (lower.includes("office")) return "Office";
  return dest;
}

// Kiosk PIN persistence: entered once by staff when setting up the kiosk
// device and stored locally. The client exchanges it for a short-lived token
// when supported, with direct PIN headers retained for older servers.
const KIOSK_PIN_KEY = "pp_kiosk_pin";
// Per-device kiosk session id (teacher-bound). Shares the PIN's storage rule:
// sessionStorage in gate-launch mode so nothing persists in a student profile.
// Page-scoped key so a simple and a badge kiosk on one device never clobber
// each other's session.
const KIOSK_SESSION_KEY = "pp_kiosk_session_simple";

export default function KioskSimplePage() {
  const [schoolId] = useState(() => new URLSearchParams(window.location.search).get("school") ?? "");
  const [kioskPin, setKioskPin] = useState(() => kioskPinStore().getItem(KIOSK_PIN_KEY) ?? "");
  const [launchTicket, setLaunchTicket] = useState(() => takeKioskLaunchTicket());
  const [pinInput, setPinInput] = useState("");
  const [grades, setGrades] = useState([]);
  const [classSource, setClassSource] = useState(null);
  const [selectedGradeId, setSelectedGradeId] = useState(null);
  const [students, setStudents] = useState([]);
  const [studentsClassId, setStudentsClassId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [checkoutStudentId, setCheckoutStudentId] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [kioskName, setKioskName] = useState(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [configError, setConfigError] = useState(null);
  // Per-device kiosk session (teacher-bound). sessionMode: null = probing the
  // server, true = session flow, false = legacy school-global flow (older
  // server without session support).
  const [session, setSession] = useState(null);
  const [sessionMode, setSessionMode] = useState(null);
  const [bootstrapError, setBootstrapError] = useState(null);
  // Device-memory resume offer from the bootstrap response: the remembered
  // teacher this device can rejoin with one tap (claim code stays the
  // fallback).
  const [resumeOffer, setResumeOffer] = useState(null);
  const inactivityRef = useRef();
  const feedbackRef = useRef();
  const scrollContainerRef = useRef(null);
  const legacyConfiguredClassRef = useRef(undefined);
  const sessionIdRef = useRef(null);
  const snapshotModeRef = useRef("unknown");
  const snapshotEtagRef = useRef(null);
  const launchAdoptionRef = useRef(null);
  const launchTicketHandledRef = useRef(false);
  const lastGradesFetchAtRef = useRef(0);
  // Blocks the 5s bootstrap interval while a resume is in flight — a
  // concurrent bootstrap would mint a fresh unclaimed session (the resume
  // force-releases the old one) and clobber the stored session id.
  const resumingRef = useRef(false);

  // Close destination picker on inactivity (10s), but keep grade selected
  const resetInactivity = useCallback(() => {
    if (inactivityRef.current) clearTimeout(inactivityRef.current);
    inactivityRef.current = setTimeout(() => {
      setCheckoutStudentId(null);
    }, 10000);
  }, []);

  useEffect(() => {
    if (!checkoutStudentId) return;
    resetInactivity();
    return () => { if (inactivityRef.current) clearTimeout(inactivityRef.current); };
  }, [checkoutStudentId, resetInactivity]);

  const kioskClient = useMemo(() => createKioskApiClient({
    schoolId,
    pin: kioskPin,
    getSessionId: () => sessionIdRef.current,
    commonHeaders: PASSPILOT_CLASS_MODEL_HEADER,
  }), [schoolId, kioskPin]);

  // 401 = wrong PIN: clear it so the PIN screen re-prompts
  const checkPinRejected = useCallback((r) => {
    if (r.status === 401) {
      kioskPinStore().removeItem(KIOSK_PIN_KEY);
      setKioskPin("");
    }
    return r;
  }, []);

  // Kiosk style is a school-wide admin setting. This page only renders the
  // "simple" style — when the server reports "badge", hop to the badge page,
  // carrying the school, the live session (its key is page-scoped, so it must
  // travel by URL), and the gate-launch storage rule. Strict match: old
  // servers omit kioskStyle and must never trigger a redirect.
  const redirectForKioskStyle = useCallback((style) => {
    if (style !== "badge") return false;
    const params = new URLSearchParams({ school: schoolId });
    const sessionId = sessionIdRef.current || kioskPinStore().getItem(KIOSK_SESSION_KEY);
    if (sessionId) params.set("session", sessionId);
    if (new URLSearchParams(window.location.search).get("launch") === "gate") {
      params.set("launch", "gate");
    }
    window.location.replace(`/passpilot/kiosk?${params.toString()}`);
    return true;
  }, [schoolId]);

  // Session died (TTL, release, teacher removed): drop it and re-bootstrap,
  // which mints a fresh claim code (and recomputes the resume offer).
  const handleSessionExpired = useCallback(() => {
    kioskPinStore().removeItem(KIOSK_SESSION_KEY);
    sessionIdRef.current = null;
    setSession(null);
    setResumeOffer(null);
    setSelectedGradeId(null);
    setStudents([]);
    setStudentsClassId(null);
    setConfigError(null);
    setSessionMode(null);
  }, []);

  const pollKiosk = useCallback(async ({ signal }) => {
    if (resumingRef.current) return { kind: "noop", revision: null };

    if (sessionMode === null) {
      if (launchTicket && !launchTicketHandledRef.current) {
        if (!isKioskLaunchTicketPending(launchTicket)) {
          launchTicketHandledRef.current = true;
        } else {
          const redemption = await redeemKioskLaunchTicket({
            client: kioskClient,
            ticket: launchTicket,
          });
          if (redemption.handled) {
            launchTicketHandledRef.current = true;
            forgetKioskLaunchTicket(launchTicket);
            if (redemption.deviceId) {
              launchAdoptionRef.current = adoptKioskDeviceId(redemption.deviceId, schoolId);
            }
          }
        }
      }
      const urlParams = new URLSearchParams(window.location.search);
      const urlSessionId = urlParams.get("session");
      const urlDeviceId = urlParams.get("device");
      const legacyAdoption = urlDeviceId ? adoptKioskDeviceId(urlDeviceId, schoolId) : null;
      const adoption = launchAdoptionRef.current || legacyAdoption || getKioskDeviceAdoption(schoolId);
      if (urlSessionId || urlDeviceId) {
        if (urlSessionId) kioskPinStore().setItem(KIOSK_SESSION_KEY, urlSessionId);
        urlParams.delete("session");
        urlParams.delete("device");
        const query = urlParams.toString();
        window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }
      const storedId = kioskPinStore().getItem(KIOSK_SESSION_KEY);
      const deviceId = adoption?.id || getKioskDeviceId(schoolId);
      const response = await kioskClient.request("/api/passpilot/kiosk/session", {
        method: "POST",
        signal,
        headers: {
          ...(storedId ? { "X-Kiosk-Session": storedId } : {}),
          ...(deviceId ? { "X-Kiosk-Device": deviceId } : {}),
          ...(adoption?.previousId ? { "X-Kiosk-Device-Prev": adoption.previousId } : {}),
        },
      });
      const data = await response.json().catch(() => null);
      if (response.status === 404 && !data?.code) {
        return {
          kind: "legacy-mode",
          launchTicketHandled: launchTicketHandledRef.current,
          revision: "legacy-mode",
        };
      }
      if (!response.ok) {
        throw new KioskRequestError(data?.error || `Kiosk unavailable (${response.status})`, {
          status: response.status,
          code: data?.code || null,
          body: data,
        });
      }
      if (!data?.session?.id) throw new Error("Kiosk session response was incomplete.");
      confirmKioskDeviceAdoption(adoption?.id, schoolId);
      return {
        kind: "bootstrap",
        data,
        launchTicketHandled: launchTicketHandledRef.current,
        revision: data.revision ?? data.session.revision ?? `session:${data.session.id}:${data.session.status}`,
      };
    }

    const requestedClassId = selectedGradeId;
    if (requestedClassId && snapshotModeRef.current !== "legacy") {
      const response = await kioskClient.request(
        `/api/passpilot/kiosk/snapshot?classId=${encodeURIComponent(requestedClassId)}`,
        {
          method: "GET",
          signal,
          headers: snapshotEtagRef.current ? { "If-None-Match": snapshotEtagRef.current } : {},
        },
      );
      if (response.status === 304) {
        return { kind: "not-modified", revision: snapshotEtagRef.current };
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 404 && !body?.code) {
        snapshotModeRef.current = "legacy";
      } else if (!response.ok) {
        snapshotModeRef.current = "snapshot";
        if (body?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          return { kind: "session-expired", revision: `expired:${sessionIdRef.current}` };
        }
        if (["PASSPILOT_KIOSK_CLASS_CHANGED", "PASSPILOT_KIOSK_CLASS_REQUIRED"].includes(body?.code)) {
          // Re-read config below to obtain the newly authoritative class.
        } else if (body?.code === "PASSPILOT_KIOSK_CLASS_INACTIVE") {
          return { kind: "config-error", data: body, revision: body?.revision ?? null };
        } else {
          throw new KioskRequestError(body?.error || "The kiosk snapshot is unavailable.", {
            status: response.status,
            code: body?.code || null,
            body,
          });
        }
      } else {
        snapshotModeRef.current = "snapshot";
        const etag = response.headers.get("etag");
        if (etag) snapshotEtagRef.current = etag;
        return {
          kind: "snapshot",
          data: normalizeKioskSnapshot(body),
          revision: kioskSnapshotRevision(response, body),
        };
      }
    }

    const configResponse = await kioskClient.request(`/api/passpilot/kiosk/config?school=${schoolId}`, {
      method: "GET",
      signal,
    });
    const config = await configResponse.json().catch(() => ({}));
    if (!configResponse.ok) {
      if (config?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
        return { kind: "session-expired", revision: `expired:${sessionIdRef.current}` };
      }
      if (configResponse.status === 401) {
        throw new KioskRequestError(config?.error || "Kiosk authorization expired.", {
          status: 401,
          code: config?.code || null,
          body: config,
        });
      }
      if (configResponse.status >= 500) {
        throw new KioskRequestError(config?.error || "The kiosk configuration is unavailable.", {
          status: configResponse.status,
          code: config?.code || null,
          body: config,
        });
      }
      return { kind: "config-error", data: config, revision: config?.revision ?? null };
    }

    const nextSource = config.source || classSource || null;
    const configuredClassId = config.classId || config.gradeId || null;
    const nextClassId = sessionMode === true
      ? (config.session?.status === "active" ? config.classId || null : null)
      : isCanonicalPassPilotSource(nextSource)
        ? config.classId || null
        : configuredClassId || selectedGradeId || null;
    let classes = null;
    if (sessionMode === false && Date.now() - lastGradesFetchAtRef.current >= 30_000) {
      try {
        const gradesResponse = await kioskClient.request(`/api/passpilot/kiosk/grades?school=${schoolId}`, {
          method: "GET",
          signal,
        });
        if (gradesResponse.status === 401) {
          throw new KioskRequestError("Kiosk authorization expired.", { status: 401 });
        }
        if (gradesResponse.ok) {
          const gradesData = await gradesResponse.json().catch(() => []);
          classes = gradesData?.classes || gradesData?.grades || gradesData || [];
          lastGradesFetchAtRef.current = Date.now();
        }
      } catch (error) {
        if (error?.name === "AbortError" || error?.status === 401) throw error;
      }
    }

    let students = null;
    if (nextClassId) {
      const classParam = isCanonicalPassPilotSource(nextSource) ? "classId" : "gradeId";
      const studentsResponse = await kioskClient.request(
        `/api/passpilot/kiosk/students?school=${schoolId}&${classParam}=${encodeURIComponent(nextClassId)}`,
        { method: "GET", signal },
      );
      const studentsData = await studentsResponse.json().catch(() => ({}));
      if (!studentsResponse.ok) {
        if (studentsData?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          return { kind: "session-expired", revision: `expired:${sessionIdRef.current}` };
        }
        throw new KioskRequestError(studentsData?.error || "The kiosk roster is unavailable.", {
          status: studentsResponse.status,
          code: studentsData?.code || null,
          body: studentsData,
        });
      }
      students = studentsData?.students || studentsData || [];
    }

    return {
      kind: "legacy-state",
      data: { config, source: nextSource, classId: nextClassId, classes, students },
      revision: config?.revision ?? null,
    };
  }, [classSource, kioskClient, launchTicket, schoolId, selectedGradeId, sessionMode]);

  const applyKioskPoll = useCallback((result) => {
    if (result.launchTicketHandled) setLaunchTicket(null);
    if (result.kind === "legacy-mode") {
      setBootstrapError(null);
      setSessionMode(false);
      return;
    }
    if (result.kind === "bootstrap") {
      const data = result.data;
      kioskPinStore().setItem(KIOSK_SESSION_KEY, data.session.id);
      sessionIdRef.current = data.session.id;
      if (redirectForKioskStyle(data.kioskStyle)) return;
      setBootstrapError(null);
      setSession(data.session);
      setResumeOffer(data.session.status === "unclaimed" ? (data.resume ?? null) : null);
      if (data.session.status === "active") {
        setClassSource(data.session.source || null);
        setSelectedGradeId(data.session.classId || null);
        setKioskName(data.session.kioskName ?? null);
      }
      setSessionMode(true);
      return;
    }
    if (result.kind === "session-expired") {
      handleSessionExpired();
      return;
    }
    if (result.kind === "config-error") {
      const error = result.data || {};
      if (redirectForKioskStyle(error.kioskStyle)) return;
      if (error.source) setClassSource(error.source);
      if (error.code === "PASSPILOT_KIOSK_CLASS_INACTIVE" || sessionMode === false) {
        setSelectedGradeId(null);
        setStudents([]);
        setStudentsClassId(null);
      }
      setConfigError({
        code: error.code || null,
        message: error.error || "The kiosk configuration is unavailable.",
      });
      setConfigLoaded(true);
      return;
    }
    if (result.kind === "snapshot") {
      const data = result.data;
      if (redirectForKioskStyle(data.kioskStyle)) return;
      setConfigLoaded(true);
      setConfigError(null);
      setClassSource(data.source);
      setKioskName(data.kioskName);
      if (data.session) setSession(data.session);
      if (Array.isArray(data.classes)) setGrades(data.classes);
      const activeClassId = data.session && data.session.status !== "active" ? null : data.classId;
      setSelectedGradeId(activeClassId);
      setStudents(activeClassId ? data.students : []);
      setStudentsClassId(activeClassId);
      return;
    }
    if (result.kind !== "legacy-state") return;

    const { config, source, classId, classes, students: nextStudents } = result.data;
    if (redirectForKioskStyle(config.kioskStyle)) return;
    setConfigLoaded(true);
    setConfigError(null);
    setClassSource(source);
    if (Array.isArray(classes)) setGrades(classes);
    if (config.kioskName !== undefined) setKioskName(config.kioskName ?? null);
    if (sessionMode === true && config.session) {
      setSession({
        id: config.session.id,
        status: config.session.status,
        claimCode: config.session.claimCode ?? null,
        source,
        classId,
        className: config.className ?? null,
        kioskName: config.kioskName ?? null,
      });
    }

    if (sessionMode === false && !isCanonicalPassPilotSource(source)) {
      const configuredClassId = config.classId || config.gradeId || null;
      const previousConfiguredClassId = legacyConfiguredClassRef.current;
      legacyConfiguredClassRef.current = configuredClassId;
      if (!configuredClassId && previousConfiguredClassId) {
        setSelectedGradeId(null);
        setStudents([]);
        setStudentsClassId(null);
        return;
      }
    }
    setSelectedGradeId(classId);
    if (Array.isArray(nextStudents)) {
      setStudents(nextStudents);
      setStudentsClassId(classId);
    } else if (!classId) {
      setStudents([]);
      setStudentsClassId(null);
    }
  }, [handleSessionExpired, redirectForKioskStyle, sessionMode]);

  const handleKioskPollError = useCallback((error) => {
    if (error?.status === 401) {
      kioskPinStore().removeItem(KIOSK_PIN_KEY);
      setKioskPin("");
      return;
    }
    if (sessionMode === null) {
      setBootstrapError(error?.message || "Kiosk is temporarily unavailable.");
    }
  }, [sessionMode]);

  const reportKioskHealth = useCallback(async (event, { signal }) => {
    await kioskClient.request("/api/passpilot/kiosk/client-health", {
      method: "POST",
      signal,
      body: JSON.stringify(event),
    });
  }, [kioskClient]);

  const kioskControllerKey = `${schoolId}:${kioskPin}:${sessionMode ?? "bootstrap"}:${session?.id || ""}:${session?.status || ""}:${selectedGradeId || ""}:${classSource || ""}`;
  const {
    isOffline,
    lastSuccessAt,
    refresh: refreshKiosk,
  } = useKioskPollingController({
    enabled: Boolean(schoolId && kioskPin),
    controllerKey: kioskControllerKey,
    request: pollKiosk,
    onResult: applyKioskPoll,
    onError: handleKioskPollError,
    onHealthEvent: reportKioskHealth,
    getRevision: (result) => result.revision,
  });

  // One-tap resume: mint a fresh active session for the remembered teacher.
  // Any failure just clears the offer — the claim code beneath it remains the
  // fallback. 401 flows through the shared PIN-rejection handling.
  const handleResume = useCallback(async () => {
    if (resumingRef.current) return;
    resumingRef.current = true;
    try {
      const deviceId = getKioskDeviceId(schoolId);
      const res = await kioskClient.request("/api/passpilot/kiosk/session/resume", {
        method: "POST",
        headers: {
          ...(deviceId ? { "X-Kiosk-Device": deviceId } : {}),
        },
      });
      checkPinRejected(res);
      if (!res.ok) {
        setResumeOffer(null);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data?.session?.id) {
        setResumeOffer(null);
        return;
      }
      kioskPinStore().setItem(KIOSK_SESSION_KEY, data.session.id);
      sessionIdRef.current = data.session.id;
      if (redirectForKioskStyle(data.kioskStyle)) return;
      setResumeOffer(null);
      setSession(data.session);
      setClassSource(data.session.source || null);
      setSelectedGradeId(data.session.classId || null);
      setKioskName(data.session.kioskName ?? null);
      setSessionMode(true);
    } catch {
      // Connection error — keep the offer; the teacher can tap again.
    } finally {
      resumingRef.current = false;
    }
  }, [checkPinRejected, kioskClient, redirectForKioskStyle, schoolId]);

  const showFeedback = (type, message) => {
    setFeedback({ type, message });
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    feedbackRef.current = setTimeout(() => setFeedback(null), 3000);
  };

  const scrollToTop = () => {
    // The roster can scroll either the inner container (viewport-constrained
    // flex layout) or the document itself (min-h-screen lets the page grow on
    // small kiosk displays) — reset both so the next student always starts at
    // the top of the list.
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleCheckout = async (studentId, destination) => {
    setCheckoutStudentId(null);
    setLoading(true);
    try {
      const res = await kioskClient.request("/api/passpilot/kiosk/checkout", {
        method: "POST",
        body: JSON.stringify({
          studentId,
          destination,
          classId: selectedGradeId,
        }),
      });
      checkPinRejected(res);
      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch { /* non-JSON */ }
        if (res.status === 404 && errBody?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          handleSessionExpired();
        } else {
          showFeedback("error", errBody?.error || "Failed to issue pass");
        }
      } else {
        showFeedback("success", "Pass issued!");
        scrollToTop();
        refreshKiosk();
      }
    } catch {
      showFeedback("error", "Connection error");
    }
    setLoading(false);
  };

  const handleCheckin = async (studentId) => {
    setLoading(true);
    try {
      const res = await kioskClient.request("/api/passpilot/kiosk/checkin", {
        method: "POST",
        body: JSON.stringify({ studentId }),
      });
      checkPinRejected(res);
      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch { /* non-JSON */ }
        if (res.status === 404 && errBody?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          handleSessionExpired();
        } else {
          showFeedback("error", errBody?.error || "Failed to check in");
        }
      } else {
        showFeedback("success", "Welcome back!");
        scrollToTop();
        refreshKiosk();
      }
    } catch {
      showFeedback("error", "Connection error");
    }
    setLoading(false);
  };

  if (!schoolId) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Kiosk Setup Required</h1>
          <p className="text-gray-400">
            Add <code className="bg-gray-800 px-2 py-1 rounded">?school=YOUR_SCHOOL_ID</code> to the URL.
          </p>
        </div>
      </div>
    );
  }

  // PIN gate — staff unlocks the kiosk device once; PIN is required by the API
  if (!kioskPin) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
        <div className="max-w-md w-full text-center space-y-6">
          <h1 className="text-3xl font-bold text-blue-400">PassPilot Kiosk</h1>
          <p className="text-gray-400">
            Staff: enter this school's kiosk PIN to unlock the kiosk on this
            device. Admins set it in PassPilot Setup &rarr; Settings.
          </p>
          <input
            type="password"
            inputMode="numeric"
            className="w-full text-center text-2xl h-16 bg-gray-800 border border-gray-600 rounded-xl text-white"
            placeholder="PIN"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pinInput.trim()) {
                kioskPinStore().setItem(KIOSK_PIN_KEY, pinInput.trim());
                setKioskPin(pinInput.trim());
                setPinInput("");
              }
            }}
            autoFocus
          />
          <button
            className="w-full h-14 text-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-xl font-semibold transition-colors"
            disabled={!pinInput.trim()}
            onClick={() => {
              kioskPinStore().setItem(KIOSK_PIN_KEY, pinInput.trim());
              setKioskPin(pinInput.trim());
              setPinInput("");
            }}
          >
            Unlock Kiosk
          </button>
        </div>
      </div>
    );
  }

  const selectedGrade = grades.find(g => g.id === selectedGradeId);
  const displayClassName = sessionMode === true ? (session?.className ?? "") : selectedGrade?.name;

  // Probing whether this server supports per-device kiosk sessions (also the
  // brief gap between a session expiring and a fresh claim code arriving).
  if (sessionMode === null) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <div className="text-center space-y-4">
          <p className="text-xl text-gray-400">Connecting kiosk&hellip;</p>
          {bootstrapError && (
            <p className="text-red-300" role="alert">{bootstrapError}</p>
          )}
        </div>
      </div>
    );
  }

  // Waiting screen: unclaimed session shows its claim code — and, when this
  // device remembers a teacher, a one-tap resume button above it.
  if (sessionMode === true && session?.status === "unclaimed") {
    const code = session.claimCode || "";
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <div className="max-w-lg w-full text-center space-y-8">
          <h1 className="text-3xl font-bold text-blue-400">PassPilot Kiosk</h1>
          {resumeOffer && (
            <button
              onClick={handleResume}
              className="w-full py-6 px-4 bg-blue-600 hover:bg-blue-500 rounded-2xl text-2xl font-semibold transition-colors"
              data-testid="kiosk-resume-button"
            >
              Resume: {resumeOffer.kioskName || "your kiosk"}
              {resumeOffer.className ? ` — ${resumeOffer.className}` : ""}
            </button>
          )}
          <div>
            <p className="text-gray-400 mb-3 text-lg">
              {resumeOffer ? "Or claim with the kiosk code" : "Kiosk code"}
            </p>
            <p className="text-7xl font-bold tracking-[0.2em] tabular-nums" data-testid="kiosk-claim-code">
              {code ? `${code.slice(0, 3)} ${code.slice(3)}` : "••• •••"}
            </p>
          </div>
          <p className="text-gray-300 text-lg">
            Teacher: open PassPilot &rarr; Kiosk Mode &rarr; Claim
            student-device kiosk (or My Class &rarr; Send to Kiosk) and enter
            this code to claim this kiosk for your class.
          </p>
        </div>
      </div>
    );
  }

  // Claimed but no class yet (self-launched without a class, or the class was
  // archived): wait for the teacher's next Send to Kiosk.
  if (sessionMode === true && (!selectedGradeId || configError)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <div className="max-w-lg text-center space-y-4" role={configError ? "alert" : undefined}>
          <h1 className="text-3xl font-bold text-blue-400">
            {session?.kioskName ? `${session.kioskName} — PassPilot Kiosk` : "PassPilot Kiosk"}
          </h1>
          <p className="text-gray-300 text-lg">
            {configError?.code === "PASSPILOT_KIOSK_CLASS_INACTIVE"
              ? "The class on this kiosk is no longer active. Press Send to Kiosk in PassPilot to choose a new class."
              : configError?.message || "Waiting for a class — press Send to Kiosk in PassPilot to choose one."}
          </p>
        </div>
      </div>
    );
  }

  if (sessionMode === false && configLoaded && isCanonicalPassPilotSource(classSource) && (configError || !selectedGradeId)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <div className="max-w-lg text-center" role={configError ? "alert" : undefined}>
          <h1 className="text-3xl font-bold text-blue-400">Kiosk Class Required</h1>
          <p className="mt-4 text-gray-300">
            {configError?.code === "PASSPILOT_KIOSK_CLASS_INACTIVE"
              ? "The configured ClassPilot class is no longer active. An administrator must select an active class before this kiosk can be used."
              : configError?.message || "An administrator must select an official ClassPilot class in PassPilot Setup before this kiosk can be used."}
          </p>
        </div>
      </div>
    );
  }

  // Grade picker (legacy school-global mode only)
  if (!selectedGradeId) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <h1 className="text-4xl font-bold mb-2 text-blue-400">PassPilot</h1>
        <p className="text-xl text-gray-400 mb-10">Select your class</p>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 max-w-2xl w-full">
          {grades.map(grade => (
            <button
              key={grade.id}
              onClick={() => setSelectedGradeId(grade.id)}
              className="bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-xl p-8 text-center transition-colors"
            >
              <span className="text-2xl font-semibold">{grade.name}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const sortByName = (a, b) =>
    `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`);

  const visibleStudents = studentsClassId === selectedGradeId ? students : [];
  const studentsOut = visibleStudents.filter(s => s.activePass).sort(sortByName);
  const studentsAvailable = visibleStudents.filter(s => !s.activePass).sort(sortByName);

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between shrink-0">
        {sessionMode === true || isCanonicalPassPilotSource(classSource) ? (
          <div className="w-16" aria-hidden="true" />
        ) : (
          <button
            onClick={() => { setSelectedGradeId(null); setCheckoutStudentId(null); }}
            className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
            Back
          </button>
        )}
        <h2 className="text-xl font-bold text-blue-400">
          {displayClassName}{kioskName ? ` \u2014 ${kioskName}` : ''}
        </h2>
        <div className="w-16" />
      </header>

      {/* Feedback toast */}
      {feedback && (
        <div className={`mx-4 mt-3 px-4 py-3 rounded-lg text-center font-medium ${
          feedback.type === "success" ? "bg-green-900/60 text-green-300" : "bg-red-900/60 text-red-300"
        }`}>
          {feedback.message}
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4 space-y-6">
        {/* Currently Out section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-5 w-5 text-orange-400" />
            <h3 className="text-lg font-semibold text-orange-300">
              Currently Out - {displayClassName}
            </h3>
          </div>
          {studentsOut.length === 0 ? (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-6 text-center text-gray-500">
              No students are currently out of class
            </div>
          ) : (
            <div className="space-y-2">
              {studentsOut.map(student => (
                <button
                  key={student.id}
                  onClick={() => handleCheckin(student.id)}
                  disabled={loading}
                  className="w-full text-left px-4 py-4 rounded-lg flex items-center justify-between transition-colors bg-orange-900/30 border border-orange-700/50 hover:bg-orange-900/50"
                >
                  <div>
                    <span className="text-lg font-medium">
                      {student.lastName}, {student.firstName}
                    </span>
                    {student.studentIdNumber && (
                      <span className="ml-3 text-sm text-gray-500">ID: {student.studentIdNumber}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="px-3 py-1 rounded-full bg-orange-800/60 text-orange-200 text-sm font-medium">
                      {getDestinationLabel(student.activePass.destination, student.activePass.customDestination)}
                    </span>
                    <span className="text-sm text-gray-400">
                      {getTimeSince(student.activePass.issuedAt)}
                    </span>
                    <span className="text-xs text-orange-400">Tap to return</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Available Students section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <span className="text-lg font-semibold text-green-300">
              Available Students - {displayClassName}
            </span>
          </div>
          {studentsAvailable.length === 0 && visibleStudents.length > 0 ? (
            <div className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-6 text-center text-gray-500">
              All students are currently out
            </div>
          ) : (
            <div className="space-y-2">
              {studentsAvailable.map(student => {
                const showDestinations = checkoutStudentId === student.id;
                return (
                  <div key={student.id}>
                    <button
                      onClick={() => setCheckoutStudentId(showDestinations ? null : student.id)}
                      disabled={loading}
                      className="w-full text-left px-4 py-4 rounded-lg flex items-center justify-between transition-colors bg-green-900/20 border border-green-700/40 hover:bg-green-900/40"
                    >
                      <div>
                        <span className="text-lg font-medium">
                          {student.lastName}, {student.firstName}
                        </span>
                        {student.studentIdNumber && (
                          <span className="ml-3 text-sm text-gray-500">ID: {student.studentIdNumber}</span>
                        )}
                      </div>
                      <span className="text-sm text-green-400">Tap to sign out</span>
                    </button>

                    {showDestinations && (
                      <div className="mt-2 ml-4 flex flex-wrap gap-2 pb-2">
                        {DESTINATIONS.map(d => {
                          const Icon = d.icon;
                          return (
                            <button
                              key={d.value}
                              onClick={() => handleCheckout(student.id, d.value)}
                              disabled={loading}
                              className="flex items-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
                            >
                              <Icon className={`h-5 w-5 ${d.color}`} />
                              <span className="text-base">{d.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {visibleStudents.length === 0 && (
          <div className="text-center text-gray-500 py-16">
            <p className="text-xl">No students in this class</p>
          </div>
        )}
      </div>
    </div>
  );
}
