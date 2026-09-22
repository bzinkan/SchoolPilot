import { z } from "zod";

export const toolId = z.string().trim().min(1).max(128);
export const toolRevision = z.number().int().positive();
export const shortText = z.string().trim().min(1).max(500);
export const resourceUrl = z.string().trim().max(2048).refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}, "Use an HTTP or HTTPS URL without credentials");
const lessonContentObject = z.object({
  title: z.string().trim().min(1).max(200), instructions: z.string().trim().max(4000).default(""),
  resources: z.array(z.object({ title: z.string().trim().min(1).max(100), url: resourceUrl }).strict()).max(10).default([]),
  checklist: z.array(z.object({ id: toolId, text: z.string().trim().min(1).max(200) }).strict()).max(20).default([]),
}).strict();
export const lessonContent = lessonContentObject.refine(value => new Set(value.checklist.map(item => item.id)).size === value.checklist.length, "Checklist IDs must be unique");
export const lessonCommand = z.union([
  z.object({ action: z.literal("start"), ...lessonContentObject.shape }).strict(),
  z.object({ action: z.literal("update"), activityId: toolId, expectedRevision: toolRevision, ...lessonContentObject.shape }).strict(),
  z.object({ action: z.literal("end"), activityId: toolId, expectedRevision: toolRevision }).strict(),
]).refine(value => !("checklist" in value) || new Set(value.checklist.map(item => item.id)).size === value.checklist.length, "Checklist IDs must be unique");
export const promptStart = z.object({
  action: z.literal("start").optional(), question: shortText, purpose: z.enum(["poll", "exit_ticket", "volunteer"]).default("poll"),
  responseType: z.enum(["choice", "short_text"]).default("choice"), options: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.responseType === "choice" && value.options.length < 2) ctx.addIssue({ code: "custom", path: ["options"], message: "Provide 2–5 options" });
  if (value.responseType === "short_text" && (value.options.length || value.purpose !== "exit_ticket")) ctx.addIssue({ code: "custom", path: ["responseType"], message: "Short text is an exit ticket without choices" });
  if (new Set(value.options.map(option => option.toLocaleLowerCase())).size !== value.options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
  if (value.purpose === "volunteer" && (value.responseType !== "choice" || value.options.join("|") !== "Yes|Pass")) ctx.addIssue({ code: "custom", path: ["options"], message: "Volunteer prompts use Yes and Pass" });
});
export const timerCommand = z.object({
  action: z.enum(["start", "stop", "pause", "resume", "extend"]), seconds: z.number().int().min(1).max(3600).optional(),
  durationSeconds: z.number().int().min(1).max(3600).optional(), message: z.string().trim().max(500).optional(),
  timerId: toolId.optional(), expectedRevision: toolRevision.optional(),
}).strict().superRefine((timer, ctx) => {
  if (timer.action === "start" && timer.seconds === undefined && timer.durationSeconds === undefined) ctx.addIssue({ code: "custom", path: ["seconds"], message: "seconds is required when starting a timer" });
  if (["pause", "resume", "extend"].includes(timer.action) && (!timer.timerId || timer.expectedRevision === undefined)) ctx.addIssue({ code: "custom", path: ["timerId"], message: "Timer identity and expected revision are required" });
  if (timer.action === "extend" && timer.seconds === undefined) ctx.addIssue({ code: "custom", path: ["seconds"], message: "Extension seconds are required" });
  if (timer.action === "start" && (timer.timerId || timer.expectedRevision !== undefined)) ctx.addIssue({ code: "custom", path: ["timerId"], message: "The server assigns timer identity" });
  if (Boolean(timer.timerId) !== (timer.expectedRevision !== undefined)) ctx.addIssue({ code: "custom", path: ["expectedRevision"], message: "Provide both timer identity and revision" });
});
export const helpInput = z.object({ category: z.enum(["assignment", "blocked_website", "technical"]), explanation: z.string().trim().max(500).default("") }).strict();
export const progressInput = z.object({ activityId: toolId, expectedRevision: z.number().int().min(0),
  status: z.enum(["working", "stuck", "ready_for_review", "finished"]).optional(), completedItemIds: z.array(toolId).max(20).optional(),
}).strict().refine(value => value.status !== undefined || value.completedItemIds !== undefined, "Choose a status or update the checklist");
export const routineStep = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("instructions"), title: z.string().trim().min(1).max(200), payload: lessonContent }).strict(),
  z.object({ kind: z.literal("resource"), title: z.string().trim().min(1).max(200), payload: z.object({ url: resourceUrl }).strict() }).strict(),
  z.object({ kind: z.literal("flight_path"), title: z.string().trim().min(1).max(200), payload: z.object({ flightPathId: toolId }).strict() }).strict(),
  z.object({ kind: z.literal("timer"), title: z.string().trim().min(1).max(200), payload: z.object({ seconds: z.number().int().min(1).max(3600), message: z.string().max(500).optional() }).strict() }).strict(),
  z.object({ kind: z.literal("poll"), title: z.string().trim().min(1).max(200), payload: promptStart }).strict(),
  z.object({ kind: z.literal("exit_ticket"), title: z.string().trim().min(1).max(200), payload: promptStart }).strict(),
]);
export const routineContent = z.object({ title: z.string().trim().min(1).max(200), steps: z.array(routineStep).min(1).max(20) }).strict().refine(value => value.steps.every(step => (step.kind !== "poll" && step.kind !== "exit_ticket") || step.payload.purpose === step.kind), "The response prompt purpose must match its step");
export function parseTemplateContent(kind: string, content: unknown) {
  if (kind === "routine") return routineContent.parse(content);
  if (kind === "activity") return lessonContent.parse(content);
  if (kind === "attention") return z.object({ message: shortText }).strict().parse(content);
  const prompt = promptStart.parse(content);
  if (prompt.purpose !== kind) throw new z.ZodError([{ code: "custom", path: ["purpose"], message: "Prompt purpose must match the template" }]);
  return prompt;
}
