import { z } from "zod";

const importResponseBlocks = z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal("redacted_thinking"), data: z.string() }),
]));

/** Thinking is provider-only metadata; only one text block may become an import draft. */
export function privateImportResponseText(content: unknown): string | null {
  const parsed = importResponseBlocks.safeParse(content);
  if (!parsed.success) return null;
  const texts = parsed.data.filter(block => block.type === "text");
  return texts.length === 1 ? texts[0]!.text : null;
}
