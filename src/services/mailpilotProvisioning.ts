import { runWithTenantContext } from "../middleware/tenantContext.js";
import {
  deleteMailpilotWatch,
  getMailpilotWatchesBySchool,
  getSchoolById,
  getStudentByEmailAnySchool,
  getStudentsBySchool,
  updateSchool,
  upsertMailpilotWatch,
} from "./storage.js";
import {
  getGmailClientForStudent,
  isMailpilotConfigured,
  startWatch,
  stopWatch,
} from "./mailpilotGmail.js";

export class MailpilotProvisioningError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = "MailpilotProvisioningError";
    this.status = status;
    this.detail = detail;
  }
}

function requireConfigured() {
  if (!isMailpilotConfigured()) {
    throw new MailpilotProvisioningError(503, "MailPilot service account not configured on server");
  }
}

export async function verifyMailpilotMailboxForSchool(schoolId: string, testEmail?: string) {
  if (!testEmail) {
    throw new MailpilotProvisioningError(400, "testEmail required");
  }
  requireConfigured();

  // Deliberately super-scoped: a foreign-school row must be visible so it can
  // be rejected instead of hidden by RLS and treated as safe.
  const student = await runWithTenantContext({ isSuper: true }, () => getStudentByEmailAnySchool(testEmail));
  if (student && student.schoolId !== schoolId) {
    throw new MailpilotProvisioningError(400, "testEmail does not belong to this school");
  }

  try {
    const gmail = getGmailClientForStudent(testEmail);
    await gmail.users.getProfile({ userId: "me" });
    return { ok: true, email: testEmail };
  } catch (err: any) {
    const msg = err?.response?.data?.error_description
      || err?.response?.data?.error
      || err?.message
      || "Unknown error";
    throw new MailpilotProvisioningError(
      400,
      "Gmail API rejected impersonation. Check domain-wide delegation in Google Admin Console.",
      String(msg).slice(0, 500)
    );
  }
}

export async function startMailpilotMonitoringForSchool(
  schoolId: string,
  options: { orgUnitPaths?: string[]; studentIds?: string[] } = {}
) {
  const school = await getSchoolById(schoolId);
  if (!school) {
    throw new MailpilotProvisioningError(404, "School not found");
  }
  if (!school.mailpilotEntitled) {
    throw new MailpilotProvisioningError(403, "MailPilot is not enabled for this school");
  }
  requireConfigured();

  const allStudents = await getStudentsBySchool(schoolId);
  const targetIds = Array.isArray(options.studentIds) && options.studentIds.length > 0
    ? new Set(options.studentIds)
    : null;
  const targetStudents = targetIds
    ? allStudents.filter((s) => targetIds.has(s.id) && s.email)
    : allStudents.filter((s) => Boolean(s.email));

  if (targetStudents.length === 0) {
    throw new MailpilotProvisioningError(400, "No students with email addresses found");
  }

  await updateSchool(schoolId, {
    classpilotEmailMonitoring: true,
    mailpilotOrgUnits: Array.isArray(options.orgUnitPaths) && options.orgUnitPaths.length > 0
      ? JSON.stringify(options.orgUnitPaths)
      : null,
  } as any);

  let started = 0;
  let failed = 0;
  const queue = [...targetStudents];
  const concurrency = 5;

  async function worker() {
    while (queue.length > 0) {
      const student = queue.shift();
      if (!student?.email) continue;
      try {
        const result = await startWatch(student.email);
        await upsertMailpilotWatch({
          schoolId,
          studentId: student.id,
          studentEmail: student.email.toLowerCase(),
          historyId: result.historyId,
          expiresAt: result.expiration,
          status: "active",
        });
        started++;
      } catch (err: any) {
        failed++;
        console.error(`[MailPilot] startWatch failed for ${student.email}:`, err?.message || err);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { enabled: true, watchesStarted: started, failed, studentsTargeted: targetStudents.length };
}

export async function stopMailpilotMonitoringForSchool(schoolId: string) {
  const watches = await getMailpilotWatchesBySchool(schoolId);
  let stopped = 0;
  const queue = [...watches];
  const concurrency = 5;

  async function worker() {
    while (queue.length > 0) {
      const watch = queue.shift();
      if (!watch) continue;
      try {
        await stopWatch(watch.studentEmail);
      } catch (err) {
        console.warn(`[MailPilot] stopWatch failed for ${watch.studentEmail}:`, (err as Error).message);
      }
      await deleteMailpilotWatch(watch.studentEmail);
      stopped++;
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await updateSchool(schoolId, {
    classpilotEmailMonitoring: false,
    mailpilotOrgUnits: null,
  } as any);
  return { enabled: false, watchesStopped: stopped };
}

export async function resyncMailpilotMonitoringForSchool(schoolId: string) {
  const school = await getSchoolById(schoolId);
  if (!school?.mailpilotEntitled) {
    throw new MailpilotProvisioningError(403, "MailPilot is not enabled for this school");
  }
  if (!school.classpilotEmailMonitoring) {
    throw new MailpilotProvisioningError(400, "Email monitoring not enabled");
  }
  requireConfigured();

  const students = await getStudentsBySchool(schoolId);
  const withEmail = students.filter((s) => s.email);
  const existingWatches = await getMailpilotWatchesBySchool(schoolId);
  const existingByEmail = new Map(existingWatches.map((w) => [w.studentEmail.toLowerCase(), w]));
  const currentStudentEmails = new Set(withEmail.map((s) => s.email!.toLowerCase()));

  let added = 0;
  let removed = 0;
  const concurrency = 5;

  const removeQueue = existingWatches.filter((w) => !currentStudentEmails.has(w.studentEmail.toLowerCase()));
  async function removeWorker() {
    while (removeQueue.length > 0) {
      const watch = removeQueue.shift();
      if (!watch) continue;
      try {
        await stopWatch(watch.studentEmail);
      } catch {
        // Best effort; deleting the local watch prevents further processing.
      }
      await deleteMailpilotWatch(watch.studentEmail);
      removed++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => removeWorker()));

  const addQueue = withEmail.filter((s) => !existingByEmail.has(s.email!.toLowerCase()));
  async function addWorker() {
    while (addQueue.length > 0) {
      const student = addQueue.shift();
      if (!student?.email) continue;
      try {
        const result = await startWatch(student.email);
        await upsertMailpilotWatch({
          schoolId,
          studentId: student.id,
          studentEmail: student.email.toLowerCase(),
          historyId: result.historyId,
          expiresAt: result.expiration,
          status: "active",
        });
        added++;
      } catch (err) {
        console.error(`[MailPilot] resync startWatch failed for ${student.email}:`, (err as Error).message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => addWorker()));

  return { added, removed, totalActive: existingWatches.length + added - removed };
}
