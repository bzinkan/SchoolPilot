import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type TodayScheduleAction = "swap" | "skip";
export type TodayScheduleInput = {
  expectedSchoolDate: string;
  currentGroupId: string;
  selectedGroupId?: string;
  currentMeetingRef?: string;
  selectedMeetingRef?: string;
  counterpartTeacherId?: string;
  action: TodayScheduleAction;
};
export type TodayScheduleWindow = {
  groupId: string; name: string; teacherId: string; teacherName: string;
  startsAt: string; endsAt: string;
};
export type TodayMeeting = TodayScheduleWindow & {
  key: string; source: string; sessionId: string | null; scheduledOccurrenceId: string | null;
  state: "future" | "current" | "ended" | "skipped" | "manual";
};
export type TodayClass = {
  groupId: string; name: string; primaryTeacherId: string; primaryTeacherName: string;
  studentIds: string[]; staffIds: string[]; rosterValid: boolean; meetings: TodayMeeting[];
};
export type TodaySchedulePlan = {
  schemaVersion: 1; action: TodayScheduleAction; input: TodayScheduleInput;
  scheduledDate: string; timeZone: string; mode: "before_bell" | "remainder";
  firstStartsAt: string; firstEndsAt: string; laterStartsAt: string | null; laterEndsAt: string | null;
  initiatorTeacherId: string; counterpartTeacherId: string | null;
  before: TodayScheduleWindow[]; after: TodayScheduleWindow[];
  groupIds: string[]; sourceMeetingKeys: string[];
};
export type TodayScheduleBlocker = { code: string; message: string };

export function todayScheduleError(message: string, code = "TODAY_SCHEDULE_INVALID", status = 409) {
  return Object.assign(new Error(message), { code, status, expose: true });
}
export function stableTodaySchedule(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableTodaySchedule).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableTodaySchedule(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const todayScheduleDigest = (value: unknown) => createHash("sha256").update(stableTodaySchedule(value)).digest("hex");

function signingSecret(): string {
  const configured = process.env.SESSION_SECRET || process.env.JWT_SECRET;
  if (!configured && (process.env.NODE_ENV === "production" || process.env.APP_ENV === "production"))
    throw todayScheduleError("Schedule review signing is unavailable.", "TODAY_SCHEDULE_UNAVAILABLE", 503);
  return configured || "classpilot-today-schedule-development-only";
}
export type TodayReviewClaims = {
  v: 1; purpose: "meeting" | "apply" | "accept"; schoolId: string; actorId: string;
  expiresAt: number; scheduledDate: string; input?: TodayScheduleInput; fingerprint?: string;
  meetingKey?: string; changeId?: string; revision?: number;
};
export function signTodayScheduleReview(claims: TodayReviewClaims): string {
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", signingSecret()).update(`classpilot-today-schedule:v1:${encoded}`).digest("base64url");
  return `${encoded}.${signature}`;
}
export function verifyTodayScheduleReview(token: string, options: {
  schoolId: string; actorId: string; purpose: TodayReviewClaims["purpose"]; now: Date;
}): TodayReviewClaims {
  try {
    if (typeof token !== "string" || token.length > 12_000) throw new Error("size");
    const [encoded, signature, extra] = token.split(".");
    if (!encoded || !signature || extra !== undefined) throw new Error("format");
    const expected = createHmac("sha256", signingSecret()).update(`classpilot-today-schedule:v1:${encoded}`).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("signature");
    const claims: TodayReviewClaims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!claims || claims.v !== 1 || claims.purpose !== options.purpose || claims.schoolId !== options.schoolId
      || claims.actorId !== options.actorId || !Number.isSafeInteger(claims.expiresAt)
      || claims.expiresAt <= options.now.getTime() || typeof claims.scheduledDate !== "string") throw new Error("claims");
    return claims;
  } catch (error) {
    if ((error as { status?: number }).status === 503) throw error;
    throw todayScheduleError("This review expired or changed. Review the schedule again.", "TODAY_SCHEDULE_REVIEW_STALE");
  }
}

export function sameTodayRoster(first: TodayClass, second: TodayClass): boolean {
  return first.rosterValid && second.rosterValid && first.studentIds.length > 0
    && first.studentIds.length === second.studentIds.length
    && first.studentIds.every((student, index) => student === second.studentIds[index]);
}
export function todayWindowOverlaps(a: Pick<TodayScheduleWindow, "startsAt" | "endsAt">,
  b: Pick<TodayScheduleWindow, "startsAt" | "endsAt">): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}
function sameWindow(a: TodayMeeting, b: TodayMeeting) { return a.startsAt === b.startsAt && a.endsAt === b.endsAt; }
function window(meeting: TodayMeeting): TodayScheduleWindow {
  return { groupId: meeting.groupId, name: meeting.name, teacherId: meeting.teacherId,
    teacherName: meeting.teacherName, startsAt: meeting.startsAt, endsAt: meeting.endsAt };
}

/** Exact reciprocal entries only; never choose the first matching class or teacher. */
export function reciprocalTodayCandidates(classes: TodayClass[], first: TodayClass, second: TodayClass,
  firstMeeting: TodayMeeting, secondMeeting: TodayMeeting) {
  const matches: Array<{ teacherId: string; teacherName: string; first: TodayMeeting; second: TodayMeeting }> = [];
  for (const currentClass of classes) {
    if (currentClass.primaryTeacherId === first.primaryTeacherId || !sameTodayRoster(currentClass, second)) continue;
    for (const current of currentClass.meetings.filter((meeting) => sameWindow(meeting, firstMeeting))) {
      for (const laterClass of classes) {
        if (laterClass.groupId === currentClass.groupId || laterClass.primaryTeacherId !== currentClass.primaryTeacherId
          || !sameTodayRoster(laterClass, first)) continue;
        for (const later of laterClass.meetings.filter((meeting) => sameWindow(meeting, secondMeeting)))
          matches.push({ teacherId: currentClass.primaryTeacherId, teacherName: currentClass.primaryTeacherName,
            first: current, second: later });
      }
    }
  }
  return matches;
}

export function buildTodaySchedulePlan(options: {
  input: TodayScheduleInput; first: TodayMeeting; second?: TodayMeeting;
  counterpart?: { first: TodayMeeting; second: TodayMeeting }; timeZone: string; now: Date;
}): TodaySchedulePlan {
  const { input, first, second, counterpart } = options;
  const at = options.now.toISOString();
  if (first.endsAt <= at) throw todayScheduleError("This period has ended. Choose a remaining period.", "TODAY_SCHEDULE_PERIOD_ENDED");
  const mode = first.startsAt > at ? "before_bell" : "remainder";
  const cutover = mode === "before_bell" ? first.startsAt : at;
  if (input.action === "skip") return {
    schemaVersion: 1, action: "skip", input, scheduledDate: input.expectedSchoolDate, timeZone: options.timeZone, mode,
    firstStartsAt: first.startsAt, firstEndsAt: first.endsAt, laterStartsAt: null, laterEndsAt: null,
    initiatorTeacherId: first.teacherId, counterpartTeacherId: null, before: [window(first)], after: [],
    groupIds: [first.groupId], sourceMeetingKeys: [first.key],
  };
  if (!second || !counterpart || second.startsAt < first.endsAt || second.startsAt <= at
    || first.groupId === second.groupId || first.teacherId !== second.teacherId)
    throw todayScheduleError("Choose two distinct, ordered periods for the same primary teacher.", "TODAY_SCHEDULE_PERIOD_PAIR_INVALID");
  const before = [first, second, counterpart.first, counterpart.second].map(window);
  if (new Set(before.map((item) => item.groupId)).size !== 4)
    throw todayScheduleError("A period swap requires four distinct saved class entries.", "TODAY_SCHEDULE_RECIPROCAL_PAIR_REQUIRED");
  const after = [
    { ...window(first), startsAt: second.startsAt, endsAt: second.endsAt },
    { ...window(second), startsAt: cutover, endsAt: first.endsAt },
    { ...window(counterpart.first), startsAt: second.startsAt, endsAt: second.endsAt },
    { ...window(counterpart.second), startsAt: cutover, endsAt: first.endsAt },
  ];
  return { schemaVersion: 1, action: "swap", input, scheduledDate: input.expectedSchoolDate,
    timeZone: options.timeZone, mode, firstStartsAt: first.startsAt, firstEndsAt: first.endsAt,
    laterStartsAt: second.startsAt, laterEndsAt: second.endsAt, initiatorTeacherId: first.teacherId,
    counterpartTeacherId: counterpart.first.teacherId, before, after,
    groupIds: before.map((item) => item.groupId).sort(),
    sourceMeetingKeys: [first.key, second.key, counterpart.first.key, counterpart.second.key].sort() };
}

/** The moving remainder timestamp is not a stale-review fence; slot identity and mode are. */
export function todayPlanReviewIdentity(plan: TodaySchedulePlan) {
  return { ...plan, after: plan.after.map((item) => ({ ...item,
    startsAt: item.endsAt === plan.firstEndsAt ? plan.firstStartsAt : item.startsAt })) };
}
