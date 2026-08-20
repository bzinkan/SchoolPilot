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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select";
import { useToast } from "../../../hooks/use-toast";
import { useCanonicalPassPilotClasses } from "../classData";
import { useKioskSessions } from "../useKioskSessions";

// Claim a student-device kiosk by the 6-digit code on its screen, binding it
// to this teacher and a class they run. Reachable from the Kiosk Mode
// dropdown (no class context — picker defaults to the first class) and from
// My Class Send to Kiosk (picker defaults to the active class).
export default function ClaimKioskDialog({
  open,
  onOpenChange,
  defaultClassId = null,
  onClaimed,
}) {
  const { toast } = useToast();
  const { claimKiosk } = useKioskSessions({ enabled: false });
  const classInventoryQuery = useCanonicalPassPilotClasses(open);
  const classes = classInventoryQuery.data?.classes || [];

  const [classId, setClassId] = useState(defaultClassId);
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Re-derive the defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setClassId(defaultClassId || null);
    setCode("");
    setError(null);
  }, [open, defaultClassId]);

  const effectiveClassId = classId || classes[0]?.id || null;
  const digits = code.replace(/\D/g, "");

  const handleClaim = async () => {
    if (digits.length !== 6 || !effectiveClassId || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await claimKiosk({ claimCode: digits, classId: effectiveClassId });
      onOpenChange(false);
      setCode("");
      toast({ title: "Kiosk Claimed", description: "The kiosk is now showing your class." });
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
            Enter the 6-digit code shown on the kiosk screen. The kiosk will be
            bound to you and show the class you pick.
          </p>
          <div className="space-y-1">
            <Label>Class to show</Label>
            <Select
              value={effectiveClassId ?? undefined}
              onValueChange={setClassId}
            >
              <SelectTrigger className="w-full" data-testid="select-kiosk-claim-class">
                <SelectValue placeholder="Choose a class..." />
              </SelectTrigger>
              <SelectContent>
                {classes.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
              disabled={submitting || digits.length !== 6 || !effectiveClassId}
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
