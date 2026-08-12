import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowLeft, Bath, Heart, Triangle, Clock } from "lucide-react";
import { isCanonicalPassPilotSource, PASSPILOT_CLASS_MODEL_HEADER } from "../classData";

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
// device, stored locally, sent on every kiosk API call. The backend requires
// it on all public kiosk endpoints.
const KIOSK_PIN_KEY = "pp_kiosk_pin";

export default function KioskSimplePage() {
  const [schoolId] = useState(() => new URLSearchParams(window.location.search).get("school") ?? "");
  const [kioskPin, setKioskPin] = useState(() => localStorage.getItem(KIOSK_PIN_KEY) ?? "");
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
  const [studentsError, setStudentsError] = useState(null);
  const inactivityRef = useRef();
  const feedbackRef = useRef();
  const scrollContainerRef = useRef(null);
  const legacyConfiguredClassRef = useRef(undefined);
  const configAvailableRef = useRef(null);

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

  const kioskHeaders = useCallback(() => ({
    "Content-Type": "application/json",
    "X-School-Id": schoolId,
    "X-Kiosk-Pin": kioskPin,
    ...PASSPILOT_CLASS_MODEL_HEADER,
  }), [schoolId, kioskPin]);

  // 401 = wrong PIN: clear it so the PIN screen re-prompts
  const checkPinRejected = useCallback((r) => {
    if (r.status === 401) {
      localStorage.removeItem(KIOSK_PIN_KEY);
      setKioskPin("");
    }
    return r;
  }, []);

  const fetchClasses = useCallback(() => {
    if (!schoolId || !kioskPin) return Promise.resolve();
    return fetch(`/api/passpilot/kiosk/grades?school=${schoolId}`, { headers: kioskHeaders() })
      .then(checkPinRejected)
      .then(r => r.ok ? r.json() : { classes: [] })
      .then(data => {
        setClassSource(data?.source || null);
        setGrades(data?.classes || data?.grades || data || []);
      })
      .catch(() => {});
  }, [schoolId, kioskPin, kioskHeaders, checkPinRejected]);

  // Refresh class inventory periodically and immediately after a disabled or
  // unavailable kiosk becomes available, without requiring a page reload.
  useEffect(() => {
    if (!schoolId || !kioskPin) return;
    fetchClasses();
    const interval = setInterval(fetchClasses, 30_000);
    return () => clearInterval(interval);
  }, [schoolId, kioskPin, fetchClasses]);

  // Poll for teacher-controlled grade
  useEffect(() => {
    if (!schoolId || !kioskPin) return;
    const poll = () => {
      fetch(`/api/passpilot/kiosk/config?school=${schoolId}`, { headers: kioskHeaders() })
        .then(checkPinRejected)
        .then(async (response) => {
          if (response.ok) return response.json();
          const body = await response.json().catch(() => ({}));
          const error = new Error(body.error || "The kiosk configuration is unavailable.");
          error.code = body.code || null;
          error.source = body.source || null;
          throw error;
        })
        .then(data => {
          const recovered = configAvailableRef.current === false;
          configAvailableRef.current = true;
          if (recovered) fetchClasses();
          setConfigError(null);
          if (data?.source) {
            setClassSource(data.source);
            if (isCanonicalPassPilotSource(data.source)) {
              setSelectedGradeId(data.classId || null);
            } else {
              const configuredClassId = data.classId || data.gradeId || null;
              const previousConfiguredClassId = legacyConfiguredClassRef.current;
              legacyConfiguredClassRef.current = configuredClassId;
              if (configuredClassId) {
                setSelectedGradeId(configuredClassId);
              } else if (previousConfiguredClassId) {
                setSelectedGradeId(null);
                setStudents([]);
                setStudentsClassId(null);
              }
            }
          }
          if (data?.kioskName !== undefined) {
            setKioskName(data.kioskName);
          }
          setConfigLoaded(true);
        })
        .catch((error) => {
          configAvailableRef.current = false;
          if (error?.source) setClassSource(error.source);
          setSelectedGradeId(null);
          setStudents([]);
          setStudentsClassId(null);
          setConfigError({
            code: error?.code || null,
            message: error?.message || "The kiosk configuration is unavailable.",
          });
          setConfigLoaded(true);
        });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [schoolId, kioskPin, kioskHeaders, checkPinRejected, fetchClasses]);

  // Poll students when grade selected
  useEffect(() => {
    if (!schoolId || !selectedGradeId || !kioskPin) return;
    let active = true;
    const poll = () => {
      const classParam = isCanonicalPassPilotSource(classSource) ? "classId" : "gradeId";
      fetch(`/api/passpilot/kiosk/students?school=${schoolId}&${classParam}=${encodeURIComponent(selectedGradeId)}`, { headers: kioskHeaders() })
        .then(checkPinRejected)
        .then(async (response) => {
          if (response.ok) return response.json();
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || "The kiosk roster is unavailable.");
        })
        .then(data => {
          if (!active) return;
          setStudents(data.students || data || []);
          setStudentsClassId(selectedGradeId);
          setStudentsError(null);
        })
        .catch((error) => {
          if (active) setStudentsError(error.message || "The kiosk roster is unavailable.");
        });
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => { active = false; clearInterval(interval); };
  }, [schoolId, selectedGradeId, classSource, kioskPin, kioskHeaders, checkPinRejected]);

  const showFeedback = (type, message) => {
    setFeedback({ type, message });
    if (feedbackRef.current) clearTimeout(feedbackRef.current);
    feedbackRef.current = setTimeout(() => setFeedback(null), 3000);
  };

  const scrollToTop = () => {
    scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleCheckout = async (studentId, destination) => {
    setCheckoutStudentId(null);
    setLoading(true);
    try {
      const res = await fetch("/api/passpilot/kiosk/checkout", {
        method: "POST",
        headers: kioskHeaders(),
        body: JSON.stringify({
          studentId,
          destination,
          classId: selectedGradeId,
        }),
      });
      checkPinRejected(res);
      if (!res.ok) {
        let errMsg = "Failed to issue pass";
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch { /* non-JSON */ }
        showFeedback("error", errMsg);
      } else {
        showFeedback("success", "Pass issued!");
        scrollToTop();
      }
    } catch {
      showFeedback("error", "Connection error");
    }
    setLoading(false);
    const classParam = isCanonicalPassPilotSource(classSource) ? "classId" : "gradeId";
    fetch(`/api/passpilot/kiosk/students?school=${schoolId}&${classParam}=${encodeURIComponent(selectedGradeId)}`, { headers: kioskHeaders() })
      .then(r => r.ok ? r.json() : { students: [] })
      .then(data => setStudents(data.students || data || []))
      .catch(() => {});
  };

  const handleCheckin = async (studentId) => {
    setLoading(true);
    try {
      const res = await fetch("/api/passpilot/kiosk/checkin", {
        method: "POST",
        headers: kioskHeaders(),
        body: JSON.stringify({ studentId }),
      });
      checkPinRejected(res);
      if (!res.ok) {
        let errMsg = "Failed to check in";
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch { /* non-JSON */ }
        showFeedback("error", errMsg);
      } else {
        showFeedback("success", "Welcome back!");
      }
    } catch {
      showFeedback("error", "Connection error");
    }
    setLoading(false);
    const classParam = isCanonicalPassPilotSource(classSource) ? "classId" : "gradeId";
    fetch(`/api/passpilot/kiosk/students?school=${schoolId}&${classParam}=${encodeURIComponent(selectedGradeId)}`, { headers: kioskHeaders() })
      .then(r => r.ok ? r.json() : { students: [] })
      .then(data => setStudents(data.students || data || []))
      .catch(() => {});
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
                localStorage.setItem(KIOSK_PIN_KEY, pinInput.trim());
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
              localStorage.setItem(KIOSK_PIN_KEY, pinInput.trim());
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

  if (configLoaded && isCanonicalPassPilotSource(classSource) && (configError || !selectedGradeId)) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center p-8">
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

  // Grade picker
  if (!selectedGradeId) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-8">
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
      {/* Header */}
      <header className="bg-gray-900 border-b border-gray-800 px-4 py-3 flex items-center justify-between shrink-0">
        {isCanonicalPassPilotSource(classSource) ? (
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
          {selectedGrade?.name}{kioskName ? ` \u2014 ${kioskName}` : ''}
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
        {studentsError ? (
          <div className="rounded-lg border border-red-700/60 bg-red-950/40 px-4 py-3 text-center text-red-200" role="alert">
            {studentsError}
          </div>
        ) : null}
        {/* Currently Out section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Clock className="h-5 w-5 text-orange-400" />
            <h3 className="text-lg font-semibold text-orange-300">
              Currently Out - {selectedGrade?.name}
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
              Available Students - {selectedGrade?.name}
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

        {!studentsError && visibleStudents.length === 0 && (
          <div className="text-center text-gray-500 py-16">
            <p className="text-xl">No students in this class</p>
          </div>
        )}
      </div>
    </div>
  );
}
