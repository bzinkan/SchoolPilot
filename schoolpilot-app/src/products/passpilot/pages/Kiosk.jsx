import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Badge } from "../../../components/ui/badge";
import { ArrowLeftRight, LogIn, X } from "lucide-react";
import { PASSPILOT_CLASS_MODEL_HEADER } from "../classData";
import KioskOfflineBanner from "../components/KioskOfflineBanner";
import {
  createKioskApiClient,
  createKioskSnapshotValidatorStore,
  KioskRequestError,
  kioskNotModifiedResult,
  kioskSnapshotRevision,
  kioskSnapshotValidatorKey,
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
  { value: "bathroom", label: "Bathroom", emoji: "\u{1F6BB}" },
  { value: "nurse", label: "Nurse", emoji: "\u{1F3E5}" },
  { value: "office", label: "Office", emoji: "\u{1F3E2}" },
  { value: "counselor", label: "Counselor", emoji: "\u{1F4AC}" },
  { value: "other_classroom", label: "Other Class", emoji: "\u{1F4DA}" },
];

const INACTIVITY_TIMEOUT = 10000; // 10 seconds

// Kiosk PIN persistence: entered once by staff when setting up the kiosk
// device and stored locally. The client exchanges it for a short-lived token
// when supported, with direct PIN headers retained for older servers.
const KIOSK_PIN_KEY = "pp_kiosk_pin";
// Per-device kiosk session id (teacher-bound). Shares the PIN's storage rule:
// sessionStorage in gate-launch mode so nothing persists in a student profile.
// Page-scoped key so a simple and a badge kiosk on one device never clobber
// each other's session.
const KIOSK_SESSION_KEY = "pp_kiosk_session_badge";

export default function KioskPage() {
  const [state, setState] = useState("scan");
  const [idInput, setIdInput] = useState("");
  const [student, setStudent] = useState(null);
  const [activePass, setActivePass] = useState(null);
  const [message, setMessage] = useState("");
  const [schoolId] = useState(() => new URLSearchParams(window.location.search).get("school") ?? "");
  const [kioskPin, setKioskPin] = useState(() => kioskPinStore().getItem(KIOSK_PIN_KEY) ?? "");
  const [launchTicket, setLaunchTicket] = useState(() => takeKioskLaunchTicket());
  const [pinInput, setPinInput] = useState("");
  // Per-device kiosk session (teacher-bound). sessionMode: null = probing,
  // true = session flow, false = legacy school-global flow (older server).
  const [session, setSession] = useState(null);
  const [sessionMode, setSessionMode] = useState(null);
  const [bootstrapError, setBootstrapError] = useState(null);
  // Device-memory resume offer from the bootstrap response (see KioskSimple).
  const [resumeOffer, setResumeOffer] = useState(null);
  const inputRef = useRef(null);
  const timeoutRef = useRef();
  const sessionIdRef = useRef(null);
  const snapshotModeRef = useRef("unknown");
  const snapshotValidatorsRef = useRef(null);
  if (!snapshotValidatorsRef.current) {
    snapshotValidatorsRef.current = createKioskSnapshotValidatorStore();
  }
  const launchAdoptionRef = useRef(null);
  const launchTicketHandledRef = useRef(false);
  // Blocks the 5s bootstrap interval while a resume is in flight — a
  // concurrent bootstrap would mint a fresh unclaimed session (the resume
  // force-releases the old one) and clobber the stored session id.
  const resumingRef = useRef(false);

  const resetSnapshotValidation = useCallback(() => {
    snapshotModeRef.current = "unknown";
    snapshotValidatorsRef.current.clear();
  }, []);

  useEffect(() => {
    resetSnapshotValidation();
  }, [
    kioskPin,
    resetSnapshotValidation,
    schoolId,
    session?.classId,
    session?.id,
    session?.source,
    sessionMode,
  ]);

  const kioskClient = useMemo(() => createKioskApiClient({
    schoolId,
    pin: kioskPin,
    getSessionId: () => sessionIdRef.current,
    commonHeaders: PASSPILOT_CLASS_MODEL_HEADER,
  }), [schoolId, kioskPin]);

  const savePin = (pin) => {
    kioskPinStore().setItem(KIOSK_PIN_KEY, pin);
    setKioskPin(pin);
    setPinInput("");
  };

  const clearPin = useCallback(() => {
    kioskPinStore().removeItem(KIOSK_PIN_KEY);
    setKioskPin("");
  }, []);

  // 401 = wrong PIN (clear and re-prompt); returns true if it handled the response
  const handlePinRejection = useCallback((res, errMsg) => {
    if (res.status === 401) {
      clearPin();
      setState("scan");
      setMessage("");
      return true;
    }
    setState("error");
    setMessage(errMsg);
    return true;
  }, [clearPin]);

  const resetToScan = useCallback(() => {
    setState("scan");
    setIdInput("");
    setStudent(null);
    setActivePass(null);
    setMessage("");
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Session died (TTL, release, teacher removed): drop it and re-bootstrap,
  // which mints a fresh claim code.
  const handleSessionExpired = useCallback(() => {
    kioskPinStore().removeItem(KIOSK_SESSION_KEY);
    sessionIdRef.current = null;
    resetSnapshotValidation();
    setSession(null);
    setResumeOffer(null);
    setSessionMode(null);
    setState("scan");
    setStudent(null);
    setActivePass(null);
    setMessage("");
  }, [resetSnapshotValidation]);

  // Kiosk style is a school-wide admin setting. This page only renders the
  // "badge" style — when the server reports "simple", hop to the simple page,
  // carrying the school, the live session (its key is page-scoped, so it must
  // travel by URL), and the gate-launch storage rule. Strict match: old
  // servers omit kioskStyle and must never trigger a redirect.
  const redirectForKioskStyle = useCallback((style) => {
    if (style !== "simple") return false;
    const params = new URLSearchParams({ school: schoolId });
    const sessionId = sessionIdRef.current || kioskPinStore().getItem(KIOSK_SESSION_KEY);
    if (sessionId) params.set("session", sessionId);
    if (new URLSearchParams(window.location.search).get("launch") === "gate") {
      params.set("launch", "gate");
    }
    window.location.replace(`/passpilot/kiosk/simple?${params.toString()}`);
    return true;
  }, [schoolId]);

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

    const classId = session?.classId || null;
    let snapshotUnsupported = false;
    if (classId && snapshotModeRef.current !== "legacy") {
      const validatorKey = kioskSnapshotValidatorKey({
        schoolId,
        sessionMode,
        sessionId: sessionIdRef.current,
        classSource: session?.source,
        classId,
      });
      const validatorEtag = snapshotValidatorsRef.current.get(validatorKey);
      const response = await kioskClient.request(
        `/api/passpilot/kiosk/snapshot?classId=${encodeURIComponent(classId)}`,
        {
          method: "GET",
          signal,
          headers: validatorEtag ? { "If-None-Match": validatorEtag } : {},
        },
      );
      if (response.status === 304) {
        return kioskNotModifiedResult({ validatorKey, validatorEtag });
      }
      const body = await response.json().catch(() => ({}));
      if (response.status === 404 && !body?.code) {
        // Defer the transport transition until the controller confirms this
        // request still belongs to the current mutation epoch.
        snapshotUnsupported = true;
      } else if (!response.ok) {
        if (body?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          return { kind: "session-expired", revision: `expired:${sessionIdRef.current}` };
        }
        if (["PASSPILOT_KIOSK_CLASS_CHANGED", "PASSPILOT_KIOSK_CLASS_REQUIRED"].includes(body?.code)) {
          // Re-read config below to pick up the authoritative class binding.
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
        const etag = response.headers.get("etag");
        const snapshot = normalizeKioskSnapshot(body);
        return {
          kind: "snapshot",
          data: snapshot,
          revision: kioskSnapshotRevision(response, body),
          transportMode: "snapshot",
          validatorKey,
          validatorEtag: etag,
        };
      }
    }

    const response = await kioskClient.request(`/api/passpilot/kiosk/config?school=${schoolId}`, {
      method: "GET",
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
        return { kind: "session-expired", revision: `expired:${sessionIdRef.current}` };
      }
      if (response.status === 401) {
        throw new KioskRequestError(data?.error || "Kiosk authorization expired.", {
          status: response.status,
          code: data?.code || null,
          body: data,
        });
      }
      if (response.status >= 500) {
        throw new KioskRequestError(data?.error || "The kiosk configuration is unavailable.", {
          status: response.status,
          code: data?.code || null,
          body: data,
        });
      }
      return { kind: "config-error", data, revision: data?.revision ?? null };
    }
    return {
      kind: "config",
      data,
      revision: data?.revision ?? data?.session?.revision ?? null,
      transportMode: snapshotUnsupported ? "legacy" : undefined,
    };
  }, [kioskClient, launchTicket, schoolId, session?.classId, session?.source, sessionMode]);

  const applyKioskPoll = useCallback((result) => {
    if (result.clearValidatorKey) {
      snapshotValidatorsRef.current.delete(result.clearValidatorKey);
    }
    if (result.transportMode && result.transportMode !== snapshotModeRef.current) {
      snapshotValidatorsRef.current.clear();
      snapshotModeRef.current = result.transportMode;
    }
    if (result.validatorKey && result.validatorEtag) {
      snapshotValidatorsRef.current.set(result.validatorKey, result.validatorEtag);
    }
    if (result.launchTicketHandled) setLaunchTicket(null);
    if (result.kind === "legacy-mode") {
      setBootstrapError(null);
      setSessionMode(false);
      return;
    }
    if (result.kind === "bootstrap") {
      const data = result.data;
      sessionIdRef.current = data.session.id;
      kioskPinStore().setItem(KIOSK_SESSION_KEY, data.session.id);
      resetSnapshotValidation();
      if (redirectForKioskStyle(data.kioskStyle)) return;
      setBootstrapError(null);
      setSession(data.session);
      setResumeOffer(data.session.status === "unclaimed" ? (data.resume ?? null) : null);
      setSessionMode(true);
      return;
    }
    if (result.kind === "session-expired") {
      handleSessionExpired();
      return;
    }
    if (result.kind === "config-error") {
      redirectForKioskStyle(result.data?.kioskStyle);
      return;
    }
    if (result.kind === "snapshot") {
      const data = result.data;
      if (redirectForKioskStyle(data.kioskStyle)) return;
      if (data.session) setSession(data.session);
      return;
    }
    if (result.kind === "config") {
      const data = result.data;
      if (redirectForKioskStyle(data.kioskStyle)) return;
      if (!data.session) return;
      setSession({
        id: data.session.id,
        status: data.session.status,
        claimCode: data.session.claimCode ?? null,
        classId: data.classId ?? null,
        className: data.className ?? null,
        kioskName: data.kioskName ?? null,
      });
    }
  }, [handleSessionExpired, redirectForKioskStyle, resetSnapshotValidation]);

  const handleKioskPollError = useCallback((error) => {
    if (error?.status === 401) {
      clearPin();
      return;
    }
    if (sessionMode === null) {
      setBootstrapError(error?.message || "Kiosk is temporarily unavailable.");
    }
  }, [clearPin, sessionMode]);

  const reportKioskHealth = useCallback(async (event, { signal }) => {
    await kioskClient.request("/api/passpilot/kiosk/client-health", {
      method: "POST",
      signal,
      body: JSON.stringify(event),
    });
  }, [kioskClient]);

  const kioskControllerKey = `${schoolId}:${kioskPin}:${sessionMode ?? "bootstrap"}:${session?.id || ""}:${session?.classId || ""}`;
  const {
    isOffline,
    lastSuccessAt,
    refresh: refreshKiosk,
    beginMutation: beginKioskMutation,
    isMutationCurrent: isKioskMutationCurrent,
    completeMutation: completeKioskMutation,
  } = useKioskPollingController({
    enabled: Boolean(schoolId && kioskPin),
    controllerKey: kioskControllerKey,
    request: pollKiosk,
    onResult: applyKioskPoll,
    onError: handleKioskPollError,
    onHealthEvent: reportKioskHealth,
    getRevision: (result) => result.revision,
  });

  // One-tap resume for the remembered teacher (see KioskSimple.handleResume).
  const handleResume = useCallback(async () => {
    if (resumingRef.current) return;
    resumingRef.current = true;
    const mutation = beginKioskMutation();
    if (!mutation) {
      resumingRef.current = false;
      return;
    }
    try {
      const deviceId = getKioskDeviceId(schoolId);
      const res = await kioskClient.request("/api/passpilot/kiosk/session/resume", {
        method: "POST",
        headers: {
          ...(deviceId ? { "X-Kiosk-Device": deviceId } : {}),
        },
      });
      if (!isKioskMutationCurrent(mutation)) return;
      if (res.status === 401) {
        clearPin();
        return;
      }
      if (!res.ok) {
        setResumeOffer(null);
        return;
      }
      const data = await res.json().catch(() => null);
      if (!isKioskMutationCurrent(mutation)) return;
      if (!data?.session?.id) {
        setResumeOffer(null);
        return;
      }
      sessionIdRef.current = data.session.id;
      kioskPinStore().setItem(KIOSK_SESSION_KEY, data.session.id);
      resetSnapshotValidation();
      if (redirectForKioskStyle(data.kioskStyle)) return;
      setResumeOffer(null);
      setSession(data.session);
      setSessionMode(true);
    } catch {
      // Connection error — keep the offer; the teacher can tap again.
    } finally {
      resumingRef.current = false;
      completeKioskMutation(mutation, { refresh: true });
    }
  }, [
    beginKioskMutation,
    clearPin,
    completeKioskMutation,
    isKioskMutationCurrent,
    kioskClient,
    redirectForKioskStyle,
    resetSnapshotValidation,
    schoolId,
  ]);

  // Auto-reset on inactivity
  useEffect(() => {
    if (state !== "scan") {
      timeoutRef.current = setTimeout(resetToScan, INACTIVITY_TIMEOUT);
      return () => clearTimeout(timeoutRef.current);
    }
  }, [state, resetToScan]);

  // Auto-focus input
  useEffect(() => {
    if (state === "scan") {
      inputRef.current?.focus();
    }
  }, [state]);

  const handleLookup = async () => {
    if (!idInput.trim() || !schoolId) return;

    try {
      const res = await kioskClient.request("/api/passpilot/kiosk/lookup", {
        method: "POST",
        body: JSON.stringify({ studentIdNumber: idInput.trim() }),
      });

      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch { /* non-JSON response */ }
        if (res.status === 404 && errBody?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          handleSessionExpired();
          return;
        }
        handlePinRejection(res, errBody?.error || "Student not found");
        return;
      }

      const data = await res.json();
      if (data.error || !data.student) {
        setState("error");
        setMessage(data.error || "Student not found");
        return;
      }
      setStudent({
        ...data.student,
        classId: data.classId || data.student.classId || data.student.classpilotGroupId || null,
      });
      setActivePass(data.activePass);
      setState("found");
    } catch {
      setState("error");
      setMessage("Connection error. Please try again.");
    }
  };

  const handleCheckout = async (destination) => {
    if (!student || !schoolId) return;

    try {
      const res = await kioskClient.request("/api/passpilot/kiosk/checkout", {
        method: "POST",
        body: JSON.stringify({
          studentId: student.id,
          destination,
          ...(student.classId ? { classId: student.classId } : {}),
        }),
      });

      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch { /* non-JSON */ }
        if (res.status === 404 && errBody?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          handleSessionExpired();
          return;
        }
        handlePinRejection(res, errBody?.error || "Failed to issue pass");
        return;
      }

      setState("success");
      setMessage(`Pass issued! Heading to ${destination}.`);
      refreshKiosk();
    } catch {
      setState("error");
      setMessage("Connection error.");
    }
  };

  const handleCheckin = async () => {
    if (!student || !schoolId) return;

    try {
      const res = await kioskClient.request("/api/passpilot/kiosk/checkin", {
        method: "POST",
        body: JSON.stringify({ studentId: student.id }),
      });

      if (!res.ok) {
        let errBody = null;
        try { errBody = await res.json(); } catch { /* non-JSON */ }
        if (res.status === 404 && errBody?.code === "PASSPILOT_KIOSK_SESSION_EXPIRED") {
          handleSessionExpired();
          return;
        }
        handlePinRejection(res, errBody?.error || "Failed to check in");
        return;
      }

      setState("success");
      setMessage("Welcome back! Pass returned.");
      refreshKiosk();
    } catch {
      setState("error");
      setMessage("Connection error.");
    }
  };

  if (!schoolId) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-8">
        <Card className="bg-gray-900 border-gray-700 max-w-md w-full">
          <CardContent className="py-12 text-center">
            <h1 className="text-2xl font-bold mb-4">Kiosk Setup Required</h1>
            <p className="text-gray-400">
              Add <code className="bg-gray-800 px-2 py-1 rounded">?school=YOUR_SCHOOL_ID</code> to the URL.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!kioskPin) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-8">
        <Card className="bg-gray-900 border-gray-700 max-w-md w-full">
          <CardContent className="py-12 text-center space-y-6">
            <h1 className="text-2xl font-bold">Enter Kiosk PIN</h1>
            <p className="text-gray-400 text-sm">
              Staff: enter this school's kiosk PIN to unlock the kiosk on this
              device. Admins set it in PassPilot Setup &rarr; Settings.
            </p>
            <Input
              type="password"
              inputMode="numeric"
              className="text-center text-2xl h-16 bg-gray-800 border-gray-600 text-white"
              placeholder="PIN"
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && pinInput.trim() && savePin(pinInput.trim())}
              autoFocus
            />
            <Button
              size="lg"
              className="w-full text-lg h-14"
              disabled={!pinInput.trim()}
              onClick={() => savePin(pinInput.trim())}
            >
              Unlock Kiosk
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Probing whether this server supports per-device kiosk sessions.
  if (sessionMode === null) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-8">
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
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-8">
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

  // Claimed but no class yet (self-launched without a class): scanning would
  // 409 on every badge, so wait for the teacher's Send to Kiosk instead.
  if (sessionMode === true && session?.status === "active" && !session?.classId) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-8">
        <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
        <div className="max-w-lg text-center space-y-4">
          <h1 className="text-3xl font-bold text-blue-400">
            {session?.kioskName ? `${session.kioskName} — PassPilot Kiosk` : "PassPilot Kiosk"}
          </h1>
          <p className="text-gray-300 text-lg">
            Waiting for a class — press Send to Kiosk in PassPilot to choose one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex flex-col items-center justify-center p-8">
      <KioskOfflineBanner isOffline={isOffline} lastSuccessAt={lastSuccessAt} />
      <h1 className="text-3xl font-bold mb-8 text-blue-400">
        PassPilot Kiosk
        {sessionMode === true && (session?.className || session?.kioskName) ? (
          <span className="block mt-1 text-lg font-medium text-gray-400">
            {[session?.className, session?.kioskName].filter(Boolean).join(" — ")}
          </span>
        ) : null}
      </h1>

      {/* Scan screen */}
      {state === "scan" && (
        <Card className="bg-gray-900 border-gray-700 max-w-md w-full">
          <CardContent className="py-8 space-y-6 text-center">
            <p className="text-xl text-gray-300">Scan your badge or enter your student ID</p>
            <Input
              ref={inputRef}
              className="text-center text-2xl h-16 bg-gray-800 border-gray-600 text-white"
              placeholder="Student ID"
              value={idInput}
              onChange={(e) => setIdInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleLookup()}
              autoFocus
            />
            <Button size="lg" className="w-full text-lg h-14" onClick={handleLookup}>
              <LogIn className="h-5 w-5 mr-2" />
              Look Up
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Student found */}
      {state === "found" && student && (
        <Card className="bg-gray-900 border-gray-700 max-w-lg w-full">
          <CardContent className="py-8 space-y-6 text-center">
            <h2 className="text-3xl font-bold">
              {student.firstName} {student.lastName}
            </h2>

            {activePass ? (
              <div className="space-y-4">
                <Badge variant="default" className="text-lg px-4 py-2">
                  Currently out: {activePass.destination}
                </Badge>
                <Button size="lg" className="w-full text-lg h-14" onClick={handleCheckin}>
                  <ArrowLeftRight className="h-5 w-5 mr-2" />
                  Check In (Return Pass)
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-gray-400">Where are you going?</p>
                <div className="grid grid-cols-2 gap-3">
                  {DESTINATIONS.map((d) => (
                    <Button
                      key={d.value}
                      size="lg"
                      variant="outline"
                      className="h-20 text-lg border-gray-600 hover:bg-gray-800 text-white"
                      onClick={() => handleCheckout(d.value)}
                    >
                      <span className="text-2xl mr-2">{d.emoji}</span>
                      {d.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            <Button variant="ghost" onClick={resetToScan} className="text-gray-500">
              <X className="h-4 w-4 mr-1" /> Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Success */}
      {state === "success" && (
        <Card className="bg-green-900/50 border-green-700 max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <div className="text-6xl">{"\u2705"}</div>
            <h2 className="text-2xl font-bold text-green-300">{message}</h2>
            <p className="text-gray-400 text-sm">Returning to scan in a few seconds...</p>
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {state === "error" && (
        <Card className="bg-red-900/50 border-red-700 max-w-md w-full">
          <CardContent className="py-12 text-center space-y-4">
            <div className="text-6xl">{"\u274C"}</div>
            <h2 className="text-xl font-bold text-red-300">{message}</h2>
            <Button variant="outline" onClick={resetToScan} className="border-red-700 bg-white text-black hover:bg-gray-100">
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
