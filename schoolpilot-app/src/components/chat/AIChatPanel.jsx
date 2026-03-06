import { useState, useRef, useEffect } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { ScrollArea } from "../ui/scroll-area";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Send, Trash2 } from "lucide-react";
import { ChatMessage } from "./ChatMessage";
import { ActionConfirmation } from "./ActionConfirmation";
import { useChat } from "../../hooks/useChat";

export function AIChatPanel({ open, onOpenChange }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const {
    messages,
    sendMessage,
    confirmAction,
    isStreaming,
    pendingAction,
    clearChat,
  } = useChat();

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [messages, pendingAction]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSend = () => {
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim());
    setInput("");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex flex-col w-full sm:max-w-md p-0"
      >
        <SheetHeader className="px-4 py-3 border-b flex-row items-center justify-between space-y-0">
          <SheetTitle className="text-base">SchoolPilot Assistant</SheetTitle>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={clearChat}
              title="Clear chat"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </SheetHeader>

        <ScrollArea ref={scrollRef} className="flex-1 px-4">
          <div className="py-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-muted-foreground text-sm py-12 space-y-2">
                <p className="font-medium">How can I help you?</p>
                <p className="text-xs">
                  Ask about any SchoolPilot feature or have me perform actions
                  for you.
                </p>
              </div>
            )}
            {messages.map((msg, i) => (
              <ChatMessage key={i} message={msg} />
            ))}
            {pendingAction && (
              <ActionConfirmation
                action={pendingAction}
                onConfirm={() => confirmAction(true)}
                onCancel={() => confirmAction(false)}
                disabled={isStreaming}
              />
            )}
          </div>
        </ScrollArea>

        <div className="border-t px-4 py-3">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              placeholder="Ask a question..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              maxLength={2000}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || isStreaming}
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
