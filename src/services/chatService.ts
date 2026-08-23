// Core chat service — manages conversations and Claude API interaction

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../prompts/systemPrompt.js";
import { getToolsForContext } from "./chatTools.js";
import { executeTool, type ToolContext } from "./chatToolExecutor.js";
import { logAudit } from "./audit.js";
import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  aiConversationStore,
  AiConversationStoreError,
  type StoredAiConversation,
} from "./aiConversationStore.js";
import { loadVerifiedSchoolIdentities } from "./schoolIdentity.js";
import { getProductLicenses, getSchoolById } from "./storage.js";
import { activeEntitledProducts } from "./productEntitlement.js";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_CHAT_ENABLED = process.env.AI_CHAT_ENABLED === "true";
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 1024;
const PENDING_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const AI_CHAT_MAX_CONCURRENT_STREAMS = 10;
let activeStreams = 0;

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
  return AI_CHAT_ENABLED && !!ANTHROPIC_API_KEY;
}

// --- Conversation store ---

interface Message {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlock[];
}

interface Conversation extends Omit<StoredAiConversation, "messages" | "context"> {
  messages: Message[];
  systemPrompt: string;
  context: ConversationContext;
  pendingToolUse?: {
    toolUseId: string;
    toolName: string;
    args: Record<string, any>;
    expiresAt: number;
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

function conversationMatchesContext(conv: Conversation, context: ConversationContext): boolean {
  return conv.context.userId === context.userId && conv.context.schoolId === context.schoolId;
}

async function auditAiEvent(
  context: ConversationContext,
  action: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await logAudit({
    schoolId: context.schoolId,
    userId: context.userId,
    userRole: context.userRole,
    action,
    entityType: "ai_chat",
    entityId: typeof metadata.conversationId === "string" ? metadata.conversationId : undefined,
    metadata,
  });
}

async function getOrCreateConversation(
  conversationId: string,
  context: ConversationContext
): Promise<Conversation> {
  let conv = await aiConversationStore.load(conversationId, context) as Conversation | null;
  if (conv && !conversationMatchesContext(conv, context)) {
    throw new Error("Conversation does not belong to the current user and school.");
  }
  if (!conv) {
    conv = {
      revision: 0,
      messages: [],
      systemPrompt: buildSystemPrompt({
        role: context.userRole,
        schoolName: context.schoolName,
        userName: context.userName,
        licensedProducts: context.licensedProducts,
      }),
      context,
      lastActivity: Date.now(),
    };
  }
  return conv;
}

async function saveConversation(
  conversationId: string,
  conv: Conversation
): Promise<Conversation> {
  return await aiConversationStore.save(
    conversationId,
    conv.context,
    conv as StoredAiConversation,
    conv.revision
  ) as Conversation;
}

async function executeToolWithFreshTenant(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
) {
  return runWithTenantContext(
    { schoolId: context.schoolId },
    async () => {
      const [identities, licenses, school] = await Promise.all([
        loadVerifiedSchoolIdentities(context.userId, context.schoolId),
        getProductLicenses(context.schoolId),
        getSchoolById(context.schoolId),
      ]);
      const identity = identities[0];
      if (!identity) throw new Error("AI_CHAT_AUTHORITY_REVOKED");
      const licensedProducts = activeEntitledProducts({ school, licenses });
      const permittedRole = identity.roles.find((role) => (
        getToolsForContext(role, licensedProducts).toolMeta.has(name)
      ));
      if (!permittedRole) throw new Error("AI_CHAT_AUTHORITY_REVOKED");
      const freshContext: ToolContext = {
        ...context,
        userRole: permittedRole,
        licensedProducts,
      };
      return executeTool(name, args, freshContext);
    }
  );
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
  context: ConversationContext,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<SSEEvent> {
  if (activeStreams >= AI_CHAT_MAX_CONCURRENT_STREAMS) {
    yield {
      type: "error",
      content: "AI chat is busy. Please retry shortly.",
    };
    return;
  }
  activeStreams += 1;

  let conv: Conversation;
  try {
    conv = await getOrCreateConversation(conversationId, context);
  } catch {
    activeStreams -= 1;
    yield { type: "error", content: "Conversation state is temporarily unavailable." };
    return;
  }
  const { tools, toolMeta } = getToolsForContext(
    context.userRole,
    context.licensedProducts
  );

  // Add user message
  conv.messages.push({ role: "user", content: userMessage });
  try {
    conv = await saveConversation(conversationId, conv);
  } catch {
    activeStreams -= 1;
    yield { type: "error", content: "Conversation state changed. Please retry." };
    return;
  }

  // Build messages for API (strip complex content blocks, keep text)
  const apiMessages: Anthropic.MessageParam[] = conv.messages.map((m) => ({
    role: m.role,
    content: m.content as any,
  }));

  try {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const anthropic = getClient();

    // Stream the response
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: conv.systemPrompt,
      messages: apiMessages,
      tools: tools.length > 0 ? tools : undefined,
    }, options.signal ? { signal: options.signal } : undefined);

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
            expiresAt: Date.now() + PENDING_CONFIRMATION_TTL_MS,
          };
          await auditAiEvent(context, "ai.tool.requested", {
            conversationId,
            toolName: tb.name,
            mutating: true,
            argumentKeys: Object.keys(tb.input || {}),
            confirmationRequired: true,
          });

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
            licensedProducts: context.licensedProducts,
            getTranscript: () => getTranscript(conv),
          };

          const result = await executeToolWithFreshTenant(tb.name, tb.input, toolCtx);
          await auditAiEvent(context, "ai.tool.executed", {
            conversationId,
            toolName: tb.name,
            mutating: false,
            argumentKeys: Object.keys(tb.input || {}),
            success: result.success,
          });

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
          }, options.signal ? { signal: options.signal } : undefined);

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

    conv = await saveConversation(conversationId, conv);
    yield { type: "done" };
  } catch {
    yield {
      type: "error",
      content: options.signal?.aborted
        ? "The AI chat request timed out or was cancelled."
        : "AI chat is temporarily unavailable.",
    };
  } finally {
    activeStreams = Math.max(0, activeStreams - 1);
  }
}

// --- Confirmation handler ---

export async function* confirmAction(
  conversationId: string,
  confirmed: boolean,
  context: ConversationContext,
  options: { signal?: AbortSignal } = {}
): AsyncGenerator<SSEEvent> {
  let conv: Conversation | null;
  try {
    conv = await aiConversationStore.load(conversationId, context) as Conversation | null;
  } catch {
    yield { type: "error", content: "Conversation state is temporarily unavailable." };
    return;
  }
  if (!conv || !conv.pendingToolUse) {
    yield {
      type: "error",
      content: "No pending action to confirm.",
    };
    return;
  }

  if (conv.pendingToolUse.expiresAt <= Date.now()) {
    conv.pendingToolUse = undefined;
    await saveConversation(conversationId, conv).catch(() => {});
    yield { type: "error", content: "The pending action expired. Please ask again." };
    return;
  }

  const { toolUseId, toolName, args } = conv.pendingToolUse;
  conv.pendingToolUse = undefined;
  try {
    // Optimistic revision makes confirmation a single-use cross-task claim.
    conv = await saveConversation(conversationId, conv);
  } catch (error) {
    yield {
      type: "error",
      content: error instanceof AiConversationStoreError && error.code === "conflict"
        ? "That action was already handled."
        : "Conversation state is temporarily unavailable.",
    };
    return;
  }

  if (!confirmed) {
    await auditAiEvent(context, "ai.tool.cancelled", {
      conversationId,
      toolName,
      mutating: true,
      argumentKeys: Object.keys(args || {}),
    });
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
    await saveConversation(conversationId, conv).catch(() => {});
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
    licensedProducts: context.licensedProducts,
    getTranscript: () => getTranscript(conv),
  };

  const result = await executeToolWithFreshTenant(toolName, args, toolCtx);
  await auditAiEvent(context, "ai.tool.executed", {
    conversationId,
    toolName,
    mutating: true,
    argumentKeys: Object.keys(args || {}),
    success: result.success,
  });

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
  let providerPermit = false;
  try {
    if (activeStreams >= AI_CHAT_MAX_CONCURRENT_STREAMS) {
      throw new Error("provider_saturated");
    }
    activeStreams += 1;
    providerPermit = true;
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
    }, options.signal ? { signal: options.signal } : undefined);

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
  } catch {
    yield {
      type: "token",
      content: result.success
        ? "Done! The action was completed successfully."
        : `There was an issue: ${result.error}`,
    };
  } finally {
    if (providerPermit) activeStreams = Math.max(0, activeStreams - 1);
  }

  await saveConversation(conversationId, conv).catch(() => {});
  yield { type: "done" };
}

export async function deleteConversation(
  conversationId: string,
  context: ConversationContext
): Promise<boolean> {
  return aiConversationStore.remove(conversationId, context);
}
