import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "../../../components/ui/button";
import { Card, CardContent } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Badge } from "../../../components/ui/badge";
import { ArrowLeftRight, LogIn, X } from "lucide-react";

const DESTINATIONS = [
  { value: "bathroom", label: "Bathroom", emoji: "\u{1F6BB}" },
  { value: "nurse", label: "Nurse", emoji: "\u{1F3E5}" },
  { value: "office", label: "Office", emoji: "\u{1F3E2}" },
  { value: "counselor", label: "Counselor", emoji: "\u{1F4AC}" },
  { value: "other_classroom", label: "Other Class", emoji: "\u{1F4DA}" },
];

const INACTIVITY_TIMEOUT = 10000; // 10 seconds

// Kiosk PIN persistence: entered once by staff when setting up the kiosk
// device, stored locally, sent on every kiosk API call. The backend requires
// it on all public kiosk endpoints.
const KIOSK_PIN_KEY = "pp_kiosk_pin";

export default function KioskPage() {
  const [state, setState] = useState("scan");
  const [idInput, setIdInput] = useState("");
  const [student, setStudent] = useState(null);
  const [activePass, setActivePass] = useState(null);
  const [message, setMessage] = useState("");
  const [schoolId] = useState(() => new URLSearchParams(window.location.search).get("school") ?? "");
  const [kioskPin, setKioskPin] = useState(() => localStorage.getItem(KIOSK_PIN_KEY) ?? "");
  const [pinInput, setPinInput] = useState("");
  const inputRef = useRef(null);
  const timeoutRef = useRef();

  const kioskHeaders = () => ({
    "Content-Type": "application/json",
    "X-School-Id": schoolId,
    "X-Kiosk-Pin": kioskPin,
  });

  const savePin = (pin) => {
    localStorage.setItem(KIOSK_PIN_KEY, pin);
    setKioskPin(pin);
    setPinInput("");
  };

  const clearPin = () => {
    localStorage.removeItem(KIOSK_PIN_KEY);
    setKioskPin("");
  };

  // 401 = wrong PIN (clear and re-prompt); returns true if it handled the response
  const handlePinRejection = (res, errMsg) => {
    if (res.status === 401) {
      clearPin();
      setState("scan");
      setMessage("");
      return true;
    }
    setState("error");
    setMessage(errMsg);
    return true;
  };

  const resetToScan = useCallback(() => {
    setState("scan");
    setIdInput("");
    setStudent(null);
    setActivePass(null);
    setMessage("");
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

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
      const res = await fetch("/api/passpilot/kiosk/lookup", {
        method: "POST",
        headers: kioskHeaders(),
        body: JSON.stringify({ studentIdNumber: idInput.trim() }),
      });

      if (!res.ok) {
        let errMsg = "Student not found";
        try {
          const err = await res.json();
          errMsg = err.error || errMsg;
        } catch { /* non-JSON response */ }
        handlePinRejection(res, errMsg);
        return;
      }

      const data = await res.json();
      if (data.error || !data.student) {
        setState("error");
        setMessage(data.error || "Student not found");
        return;
      }
      setStudent(data.student);
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
      const res = await fetch("/api/passpilot/kiosk/checkout", {
        method: "POST",
        headers: kioskHeaders(),
        body: JSON.stringify({ studentId: student.id, destination }),
      });

      if (!res.ok) {
        let errMsg = "Failed to issue pass";
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch { /* non-JSON */ }
        handlePinRejection(res, errMsg);
        return;
      }

      setState("success");
      setMessage(`Pass issued! Heading to ${destination}.`);
    } catch {
      setState("error");
      setMessage("Connection error.");
    }
  };

  const handleCheckin = async () => {
    if (!student || !schoolId) return;

    try {
      const res = await fetch("/api/passpilot/kiosk/checkin", {
        method: "POST",
        headers: kioskHeaders(),
        body: JSON.stringify({ studentId: student.id }),
      });

      if (!res.ok) {
        let errMsg = "Failed to check in";
        try { const err = await res.json(); errMsg = err.error || errMsg; } catch { /* non-JSON */ }
        handlePinRejection(res, errMsg);
        return;
      }

      setState("success");
      setMessage("Welcome back! Pass returned.");
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 to-black text-white flex flex-col items-center justify-center p-8">
      <h1 className="text-3xl font-bold mb-8 text-blue-400">PassPilot Kiosk</h1>

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
