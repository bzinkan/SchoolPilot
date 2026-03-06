// Core chat service — manages conversations and Claude API interaction

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../prompts/systemPrompt.js";
import { getToolsForContext, type ChatTool } from "./chatTools.js";
import { executeTool, type ToolContext } from "./chatToolExecutor.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;
const CONVERSATION_TTL_MS = 30 * 60 * 1000; // 30 minutes

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is not configured");
    }
    client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  }
  return client;
}

export function isChatAvailable(): boolean {
  return !!ANTHROPIC_API_KEY;
}

// --- Conversation store ---

interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

interface Conversation {
  messages: Message[];
  systemPrompt: string;
  context: ConversationContext;
  lastActivity: Date;
  pendingToolUse?: {
    toolUseId: string;
    toolName: string;
    args: Record<string, any>;
    toolMeta: ChatTool;
  };
}

export interface ConversationContext {
  userId: string;
  schoolId: string;
  schoolName: string;
  userName: string;
  userRole: string;
  licensedProducts: string[];
}

const conversations = new Map<string, Conversation>();

// Cleanup expired conversations every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, conv] of conversations) {
    if (now - conv.lastActivity.getTime() > CONVERSATION_TTL_MS) {
      conversations.delete(id);
    }
  }
}, 5 * 60 * 1000);

function getOrCreateConversation(
  conversationId: string,
  context: ConversationContext
): Conversation {
  let conv = conversations.get(conversationId);
  if (!conv) {
    conv = {
      messages: [],
      systemPrompt: buildSystemPrompt({
        role: context.userRole,
        schoolName: context.schoolName,
        userName: context.userName,
        licensedProducts: context.licensedProducts,
      }),
      context,
      lastActivity: new Date(),
    };
    conversations.set(conversationId, conv);
  }
  conv.lastActivity = new Date();
  return conv;
}

function getTranscript(conv: Conversation, maxMessages = 10): string {
  const recent = conv.messages.slice(-maxMessages);
  return recent
    .map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("");
      return `[${m.role}]: ${content}`;
    })
    .join("\n\n");
}

// --- SSE Event types ---

export interface SSEEvent {
  type: "token" | "confirmation" | "action_result" | "done" | "error";
  content?: string;
  action?: string;
  params?: Record<string, any>;
  description?: string;
  success?: boolean;
  data?: any;
}

// --- Main message handler ---

export async function* sendMessage(
  conversationId: string,
  userMessage: string,
  context: ConversationContext
): AsyncGenerator<SSEEvent> {
  const conv = getOrCreateConversation(conversationId, context);
  const { tools, toolMeta } = getToolsForContext(
    context.userRole,
    context.licensedProducts
  );

  // Add user message
  conv.messages.push({ role: "user", content: userMessage });

  // Build messages for API (strip complex content blocks, keep text)
  const apiMessages: Anthropic.MessageParam[] = conv.messages.map((m) => ({
    role: m.role,
    content: m.content as any,
  }));

  try {
    const anthropic = getClient();

    // Stream the response
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      messages: apiMessages,
      tools: tools.length > 0 ? tools : undefined,
    });

    let fullText = "";
    let toolUseBlocks: any[] = [];

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        fullText += event.delta.text;
        yield { type: "token", content: event.delta.text };
      }

      if (
        event.type === "content_block_start" &&
        event.content_block.type === "tool_use"
      ) {
        toolUseBlocks.push({
          id: event.content_block.id,
          name: event.content_block.name,
          input: {},
        });
      }

      if (
        event.type === "content_block_delta" &&
        event.delta.type === "input_json_delta"
      ) {
        // Accumulate tool input JSON
        const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
        if (lastTool) {
          lastTool._rawInput =
            (lastTool._rawInput || "") + event.delta.partial_json;
        }
      }

      if (event.type === "content_block_stop" && toolUseBlocks.length > 0) {
        const lastTool = toolUseBlocks[toolUseBlocks.length - 1];
        if (lastTool && lastTool._rawInput) {
          try {
            lastTool.input = JSON.parse(lastTool._rawInput);
          } catch {
            // partial JSON — leave empty
          }
          delete lastTool._rawInput;
        }
      }
    }

    // Build the assistant content blocks for conversation history
    const assistantContent: any[] = [];
    if (fullText) {
      assistantContent.push({ type: "text", text: fullText });
    }
    for (const tb of toolUseBlocks) {
      assistantContent.push({
        type: "tool_use",
        id: tb.id,
        name: tb.name,
        input: tb.input,
      });
    }
    conv.messages.push({
      role: "assistant",
      content: assistantContent.length > 0 ? assistantContent : fullText,
    });

    // Process tool calls
    if (toolUseBlocks.length > 0) {
      for (const tb of toolUseBlocks) {
        const meta = toolMeta.get(tb.name);

        if (meta && meta.mutating) {
          // Store pending tool use for confirmation
          conv.pendingToolUse = {
            toolUseId: tb.id,
            toolName: tb.name,
            args: tb.input,
            toolMeta: meta,
          };

          yield {
            type: "confirmation",
            action: tb.name,
            params: tb.input,
            description: `${meta.definition.description}`,
          };
        } else {
          // Read-only tool — execute immediately
          const toolCtx: ToolContext = {
            userId: context.userId,
            schoolId: context.schoolId,
            schoolName: context.schoolName,
            userName: context.userName,
            userRole: context.userRole,
            getTranscript: () => getTranscript(conv),
          };

          const result = await executeTool(tb.name, tb.input, toolCtx);

          // Add tool result to conversation
          conv.messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: tb.id,
                content: JSON.stringify(result),
              },
            ] as any,
          });

          // Get Claude's response to the tool result
          const followUp = await anthropic.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: conv.systemPrompt,
            messages: conv.messages.map((m) => ({
              role: m.role,
              content: m.content as any,
            })),
            tools: tools.length > 0 ? tools : undefined,
          });

          let followUpText = "";
          for (const block of followUp.content) {
            if (block.type === "text") {
              followUpText += block.text;
              yield { type: "token", content: block.text };
            }
          }

          if (followUpText) {
            conv.messages.push({ role: "assistant", content: followUpText });
          }
        }
      }
    }

    yield { type: "done" };
  } catch (err: any) {
    console.error("[ChatService] Error:", err);
    yield {
      type: "error",
      content:
        err.message || "An error occurred while processing your message.",
    };
  }
}

// --- Confirmation handler ---

export async function* confirmAction(
  conversationId: string,
  confirmed: boolean,
  context: ConversationContext
): AsyncGenerator<SSEEvent> {
  const conv = conversations.get(conversationId);
  if (!conv || !conv.pendingToolUse) {
    yield {
      type: "error",
      content: "No pending action to confirm.",
    };
    return;
  }

  const { toolUseId, toolName, args } = conv.pendingToolUse;
  conv.pendingToolUse = undefined;

  if (!confirmed) {
    // User cancelled — add tool result indicating cancellation
    conv.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: JSON.stringify({
            success: false,
            error: "User cancelled the action.",
          }),
        },
      ] as any,
    });

    yield {
      type: "token",
      content: "Okay, I've cancelled that action. Is there anything else I can help with?",
    };
    conv.messages.push({
      role: "assistant",
      content: "Okay, I've cancelled that action. Is there anything else I can help with?",
    });
    yield { type: "done" };
    return;
  }

  // Execute the confirmed action
  const toolCtx: ToolContext = {
    userId: context.userId,
    schoolId: context.schoolId,
    schoolName: context.schoolName,
    userName: context.userName,
    userRole: context.userRole,
    getTranscript: () => getTranscript(conv),
  };

  const result = await executeTool(toolName, args, toolCtx);

  yield {
    type: "action_result",
    success: result.success,
    data: result.data,
  };

  // Add tool result to conversation
  conv.messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: JSON.stringify(result),
      },
    ] as any,
  });

  // Get Claude's summary of the result
  try {
    const anthropic = getClient();
    const { tools } = getToolsForContext(
      context.userRole,
      context.licensedProducts
    );

    const followUp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      messages: conv.messages.map((m) => ({
        role: m.role,
        content: m.content as any,
      })),
      tools: tools.length > 0 ? tools : undefined,
    });

    let followUpText = "";
    for (const block of followUp.content) {
      if (block.type === "text") {
        followUpText += block.text;
        yield { type: "token", content: block.text };
      }
    }

    if (followUpText) {
      conv.messages.push({ role: "assistant", content: followUpText });
    }
  } catch (err: any) {
    console.error("[ChatService] Follow-up error:", err);
    yield {
      type: "token",
      content: result.success
        ? "Done! The action was completed successfully."
        : `There was an issue: ${result.error}`,
    };
  }

  yield { type: "done" };
}

export function deleteConversation(conversationId: string): boolean {
  return conversations.delete(conversationId);
}
