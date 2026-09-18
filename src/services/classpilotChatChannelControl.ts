/**
 * Soft chat pause for the student FAB.
 *
 * `session_settings.chat_enabled=false` is the hard switch: the student's chat
 * box disappears entirely. A pause keeps the thread visible on the device but
 * refuses new student messages, so a teacher can quiet a class (or a testing
 * block can quiet it automatically) without erasing the conversation.
 *
 * Pure so that the FAB builder, the scheduled classroom tools, the student
 * write gate and the routes all agree on one rule.
 */
export type ChatPauseReason = "teacher" | "testing" | null;

export type ChatPauseInput = {
  /** The per-activity `session_settings.chat_paused` flag. */
  chatPaused?: boolean | null;
  /** `scheduledSupervisionSource(context)` for a supervision context; null for a class session. */
  contextSource?: string | null;
  /** School setting; a missing row means the default (true). */
  pauseChatDuringTesting?: boolean | null;
};

export type ChatPauseState = { messagesPaused: boolean; pauseReason: ChatPauseReason };

/** A teacher's explicit pause names the teacher even inside a testing block. */
export function resolveChatPause(input: ChatPauseInput): ChatPauseState {
  if (input.chatPaused === true) return { messagesPaused: true, pauseReason: "teacher" };
  if (input.contextSource === "scheduled_testing" && input.pauseChatDuringTesting !== false) {
    return { messagesPaused: true, pauseReason: "testing" };
  }
  return { messagesPaused: false, pauseReason: null };
}

export const STUDENT_CHAT_COOLDOWN = Object.freeze({
  burst: Object.freeze({ windowMs: 30_000, max: 5 }),
  sustained: Object.freeze({ windowMs: 5 * 60_000, max: 30 }),
});

/** Clamp the wait the device is told so a stale window never yields 0 or an hour. */
export function studentChatRetryAfterMs(resetTime: Date | undefined, windowMs: number, now = Date.now()): number {
  const target = resetTime instanceof Date && Number.isFinite(resetTime.getTime()) ? resetTime.getTime() : now + windowMs;
  return Math.min(Math.max(target - now, 1_000), windowMs);
}
