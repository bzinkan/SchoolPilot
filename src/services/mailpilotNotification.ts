import { createHash } from "node:crypto";

export type MailpilotMessageIdentity = {
  schoolId: string; studentId: string; studentEmail: string; gmailMessageId: string;
};

/** Stable after raw email retention; the provider identifier itself is not retained here. */
export function mailpilotSafetySourceId(identity: Pick<MailpilotMessageIdentity,"schoolId"|"studentId"|"gmailMessageId">): string {
  return `gmail-v1:${createHash("sha256").update(JSON.stringify([identity.schoolId,identity.studentId,identity.gmailMessageId])).digest("hex")}`;
}

export function mailpilotRetryError(code: string): Error & { code: string; status: number } {
  return Object.assign(new Error("MailPilot processing is incomplete; retry is required."), {code,status:503});
}

export function validMailpilotHistoryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{1,40}$/.test(value);
}

export function mailpilotHistoryCovered(current: string | null, notification: string | null): boolean {
  return validMailpilotHistoryId(current) && validMailpilotHistoryId(notification) && BigInt(current) >= BigInt(notification);
}

export function mailpilotClassificationAvailable(value: {category:string;confidence:number;reasoning:string}|null): boolean {
  return value !== null && !(value.category === "unknown" && value.confidence === 0 && value.reasoning === "Classification unavailable");
}

/** Successful messages may commit individually; the cursor commits only after every message succeeds. */
export async function processMailpilotHistoryBatch(options: {
  messageIds: readonly string[];
  processMessage: (messageId:string) => Promise<"alert"|"benign"|"skipped">;
  recordStats: (stats:{messagesScanned:number;alertsRaised:number;errors:number}) => Promise<void>;
  complete: () => Promise<void>;
}): Promise<void> {
  let alertsRaised=0,errors=0;
  for(const messageId of new Set(options.messageIds)) {
    try { if(await options.processMessage(messageId)==="alert") alertsRaised++; }
    catch { errors++; }
  }
  await options.recordStats({messagesScanned:new Set(options.messageIds).size,alertsRaised,errors});
  if(errors) throw mailpilotRetryError("MAILPILOT_MESSAGE_BATCH_INCOMPLETE");
  await options.complete();
}
