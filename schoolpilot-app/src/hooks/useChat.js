import { useState, useCallback, useRef } from "react";

export function useChat() {
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const conversationIdRef = useRef(null);

  const sendMessage = useCallback(
    async (text) => {
      if (!text.trim() || isStreaming) return;

      const userMsg = { role: "user", content: text };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      // Generate conversationId on first message
      if (!conversationIdRef.current) {
        conversationIdRef.current = crypto.randomUUID();
      }

      // Add placeholder assistant message
      const assistantIdx = messages.length + 1;
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      try {
        const res = await fetch("/api/chat/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            message: text,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Request failed" }));
          setMessages((prev) => {
            const updated = [...prev];
            updated[assistantIdx] = {
              role: "assistant",
              content: err.error || "Something went wrong.",
            };
            return updated;
          });
          setIsStreaming(false);
          return;
        }

        await readSSEStream(res, assistantIdx);
      } catch {
        setMessages((prev) => {
          const updated = [...prev];
          updated[assistantIdx] = {
            role: "assistant",
            content: "Failed to connect. Please try again.",
          };
          return updated;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, messages.length]
  );

  const confirmAction = useCallback(
    async (confirmed) => {
      if (!conversationIdRef.current) return;

      setPendingAction(null);
      setIsStreaming(true);

      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

      try {
        const res = await fetch("/api/chat/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            conversationId: conversationIdRef.current,
            confirmed,
          }),
        });

        if (!res.ok) {
          setMessages((prev) => {
            const updated = [...prev];
            updated[updated.length - 1] = {
              role: "assistant",
              content: "Something went wrong confirming the action.",
            };
            return updated;
          });
          setIsStreaming(false);
          return;
        }

        await readSSEStream(res, null);
      } catch {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: "Failed to connect. Please try again.",
          };
          return updated;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [messages.length]
  );

  const readSSEStream = useCallback(async (res, fixedIdx) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr) continue;

        try {
          const event = JSON.parse(jsonStr);

          if (event.type === "token") {
            setMessages((prev) => {
              const updated = [...prev];
              const idx = fixedIdx != null ? fixedIdx : updated.length - 1;
              const msg = updated[idx];
              if (msg) {
                updated[idx] = {
                  ...msg,
                  content: msg.content + event.content,
                };
              }
              return updated;
            });
          } else if (event.type === "confirmation") {
            setPendingAction({
              action: event.action,
              params: event.params,
              description: event.description,
            });
          } else if (event.type === "action_result") {
            setMessages((prev) => {
              const updated = [...prev];
              const idx = updated.length - 1;
              const resultText = event.success
                ? "Action completed successfully."
                : "Action failed.";
              updated[idx] = {
                ...updated[idx],
                content: updated[idx].content || resultText,
                actionResult: event,
              };
              return updated;
            });
          } else if (event.type === "error") {
            setMessages((prev) => {
              const updated = [...prev];
              const idx = fixedIdx != null ? fixedIdx : updated.length - 1;
              if (updated[idx]) {
                updated[idx] = {
                  ...updated[idx],
                  content:
                    updated[idx].content ||
                    event.content ||
                    "An error occurred.",
                };
              }
              return updated;
            });
          }
          // "done" — no action needed
        } catch {
          // skip malformed JSON
        }
      }
    }
  }, []);

  const clearChat = useCallback(async () => {
    if (conversationIdRef.current) {
      try {
        await fetch(`/api/chat/conversations/${conversationIdRef.current}`, {
          method: "DELETE",
          credentials: "include",
        });
      } catch {
        // ignore
      }
    }
    conversationIdRef.current = null;
    setMessages([]);
    setPendingAction(null);
  }, []);

  return {
    messages,
    sendMessage,
    confirmAction,
    isStreaming,
    pendingAction,
    clearChat,
    conversationId: conversationIdRef.current,
  };
}
