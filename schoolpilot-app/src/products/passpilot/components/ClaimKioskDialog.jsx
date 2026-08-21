import { useEffect, useState } from "react";

import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { useToast } from "../../../hooks/use-toast";
import { useKioskSessions } from "../useKioskSessions";

// Claim a student-device kiosk by the 6-digit code on its screen, binding it
// to this teacher. There is no class picker: from the Kiosk Mode dropdown the
// claim is teacher-only (the kiosk shows the teacher's name and waits for
// Send to Kiosk); from My Class Send to Kiosk, defaultClassId carries the
// active class so that entry point still puts the class up in one step.
export default function ClaimKioskDialog({
  open,
  onOpenChange,
  defaultClassId = null,
  onClaimed,
}) {
  const { toast } = useToast();
  const { claimKiosk } = useKioskSessions({ enabled: false });

  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setCode("");
    setError(null);
  }, [open]);

  const digits = code.replace(/\D/g, "");

  const handleClaim = async () => {
    if (digits.length !== 6 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await claimKiosk({ claimCode: digits, classId: defaultClassId ?? null });
      onOpenChange(false);
      setCode("");
      toast({
        title: "Kiosk Claimed",
        description: defaultClassId
          ? "The kiosk is now showing your class."
          : "The kiosk is bound to you — use Send to Kiosk to put a class on it.",
      });
      onClaimed?.();
    } catch (err) {
      setError(
        err?.response?.status === 404
          ? "Code not found or expired — check the kiosk screen for the current code."
          : (err?.response?.data?.error || "Failed to claim kiosk.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Claim a kiosk</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {defaultClassId
              ? "Enter the 6-digit code shown on the kiosk screen. The kiosk will be bound to you and show your class."
              : "Enter the 6-digit code shown on the kiosk screen. The kiosk will be bound to you — send it a class any time from My Class."}
          </p>
          <div className="space-y-1">
            <Label htmlFor="kiosk-claim-code">Kiosk code</Label>
            <Input
              id="kiosk-claim-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="123 456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleClaim();
              }}
              data-testid="input-kiosk-claim-code"
              autoFocus
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">{error}</p>
          )}
          <div className="flex justify-end space-x-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              data-testid="button-cancel-kiosk-claim"
            >
              Cancel
            </Button>
            <Button
              onClick={handleClaim}
              disabled={submitting || digits.length !== 6}
              data-testid="button-submit-kiosk-claim"
            >
              Claim Kiosk
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
