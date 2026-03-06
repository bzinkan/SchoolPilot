import { useState } from "react";
import { Button } from "../ui/button";
import { MessageCircle } from "lucide-react";
import { AIChatPanel } from "./AIChatPanel";
import { useAuth } from "../../contexts/AuthContext";

export function AIChatButton() {
  const [open, setOpen] = useState(false);
  const { user } = useAuth();

  // Only show for authenticated users
  if (!user) return null;

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        size="icon"
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg"
      >
        <MessageCircle className="h-5 w-5" />
      </Button>
      <AIChatPanel open={open} onOpenChange={setOpen} />
    </>
  );
}
