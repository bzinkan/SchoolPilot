import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requireSchoolContext } from "../../middleware/requireSchoolContext.js";
import { requireActiveSchool } from "../../middleware/requireActiveSchool.js";
import { requireProductLicense } from "../../middleware/requireProductLicense.js";
import { requireRole } from "../../middleware/requireRole.js";
import {
  getSchoolById,
  updateSchool,
  getStudentsBySchool,
  getStudentByEmailAnySchool,
  getMailpilotWatchesBySchool,
  getMailpilotWatchByEmail,
  upsertMailpilotWatch,
  deleteMailpilotWatch,
} from "../../services/storage.js";
import {
  getServiceAccountClientId,
  getServiceAccountScope,
  isMailpilotConfigured,
  getGmailClientForStudent,
  startWatch,
  stopWatch,
} from "../../services/mailpilotGmail.js";
import { logAudit } from "../../services/audit.js";
import { runWithTenantContext } from "../../middleware/tenantContext.js";

const router = Router();

const auth = [
  authenticate,
  requireSchoolContext,
  requireActiveSchool,
  requireProductLicense("CLASSPILOT"),
  requireRole("admin", "school_admin"),
] as const;

// GET /api/mailpilot/setup/info - wizard info (SA client ID, scope, enabled flag)
router.get("/setup/info", ...auth, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const school = await getSchoolById(schoolId);
    const clientId = getServiceAccountClientId();
    const configured = isMailpilotConfigured();
    const orgUnits = school?.mailpilotOrgUnits ? safeParseJson(school.mailpilotOrgUnits) : [];
    const watches = await getMailpilotWatchesBySchool(schoolId);

    return res.json({
      enabled: Boolean(school?.classpilotEmailMonitoring),
      configured, // server has SA key + Pub/Sub topic configured
      serviceAccountClientId: clientId,
      scope: getServiceAccountScope(),
      orgUnits,
      mailboxesMonitored: watches.filter((w) => w.status === "active").length,
      mailboxesWithErrors: watches.filter((w) => w.status === "error").length,
      totalWatches: watches.length,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailpilot/setup/verify - test DWD by calling Gmail API for one student
router.post("/setup/verify", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const { testEmail } = req.body as { testEmail?: string };
    if (!testEmail) {
      return res.status(400).json({ error: "testEmail required" });
    }
    if (!isMailpilotConfigured()) {
      return res.status(503).json({ error: "MailPilot service account not configured on server" });
    }

    // Confirm the test email belongs to this school (or domain matches). This is
    // a deliberate cross-school existence check — the guard below rejects emails
    // owned by another school — so it must run super-scoped or RLS would hide the
    // foreign row and the check would fail open.
    const student = await runWithTenantContext({ isSuper: true }, () => getStudentByEmailAnySchool(testEmail));
    if (student && student.schoolId !== schoolId) {
      return res.status(400).json({ error: "testEmail does not belong to this school" });
    }

    try {
      const gmail = getGmailClientForStudent(testEmail);
      await gmail.users.getProfile({ userId: "me" });
      return res.json({ ok: true, email: testEmail });
    } catch (err: any) {
      const msg = err?.response?.data?.error_description
        || err?.response?.data?.error
        || err?.message
        || "Unknown error";
      const status = err?.code || err?.status || 500;
      return res.status(400).json({
        ok: false,
        error: "Gmail API rejected impersonation. Check domain-wide delegation in Google Admin Console.",
        detail: String(msg).slice(0, 500),
        status,
      });
    }
  } catch (err) {
    next(err);
  }
});

// POST /api/mailpilot/setup/enable - turn monitoring ON + start watches
router.post("/setup/enable", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const school = await getSchoolById(schoolId);
    if (!school) return res.status(404).json({ error: "School not found" });

    if (!isMailpilotConfigured()) {
      return res.status(503).json({ error: "MailPilot service account not configured on server" });
    }

    const { orgUnitPaths, studentIds } = req.body as {
      orgUnitPaths?: string[];
      studentIds?: string[];
    };

    // Determine which student emails to watch
    let targetStudents: Array<{ id: string; email: string | null }>;
    const allStudents = await getStudentsBySchool(schoolId);
    if (Array.isArray(studentIds) && studentIds.length > 0) {
      const ids = new Set(studentIds);
      targetStudents = allStudents.filter((s) => ids.has(s.id) && s.email);
    } else {
      // Default: every student with an email address
      targetStudents = allStudents.filter((s) => Boolean(s.email));
    }

    if (targetStudents.length === 0) {
      return res.status(400).json({ error: "No students with email addresses found" });
    }

    // Flip the flag
    await updateSchool(schoolId, {
      classpilotEmailMonitoring: true,
      mailpilotOrgUnits: orgUnitPaths && orgUnitPaths.length > 0 ? JSON.stringify(orgUnitPaths) : null,
    });

    // Start Gmail watches (batch with concurrency cap to avoid quota bursts)
    let started = 0;
    let failed = 0;
    const concurrency = 5;
    const queue = [...targetStudents];
    async function worker() {
      while (queue.length > 0) {
        const s = queue.shift();
        if (!s || !s.email) continue;
        try {
          const result = await startWatch(s.email);
          await upsertMailpilotWatch({
            schoolId,
            studentId: s.id,
            studentEmail: s.email.toLowerCase(),
            historyId: result.historyId,
            expiresAt: result.expiration,
            status: "active",
          });
          started++;
        } catch (err: any) {
          failed++;
          console.error(`[MailPilot] startWatch failed for ${s.email}:`, err?.message || err);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "mailpilot_enable",
      entityType: "school",
      entityId: schoolId,
      schoolId,
      metadata: { studentsTargeted: targetStudents.length, started, failed },
    });

    return res.json({ enabled: true, watchesStarted: started, failed });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailpilot/setup/disable - turn monitoring OFF + stop all watches
router.post("/setup/disable", ...auth, async (req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const watches = await getMailpilotWatchesBySchool(schoolId);

    let stopped = 0;
    const concurrency = 5;
    const queue = [...watches];
    async function worker() {
      while (queue.length > 0) {
        const w = queue.shift();
        if (!w) continue;
        try {
          await stopWatch(w.studentEmail);
        } catch (err) {
          console.warn(`[MailPilot] stopWatch failed for ${w.studentEmail}:`, (err as Error).message);
        }
        await deleteMailpilotWatch(w.studentEmail);
        stopped++;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    await updateSchool(schoolId, {
      classpilotEmailMonitoring: false,
      mailpilotOrgUnits: null,
    });

    await logAudit({
      userId: req.authUser!.id,
      userEmail: req.authUser!.email,
      action: "mailpilot_disable",
      entityType: "school",
      entityId: schoolId,
      schoolId,
      metadata: { watchesStopped: stopped },
    });

    return res.json({ enabled: false, watchesStopped: stopped });
  } catch (err) {
    next(err);
  }
});

// POST /api/mailpilot/setup/resync - re-enumerate students and sync watches (add new, stop removed)
router.post("/setup/resync", ...auth, async (_req, res, next) => {
  try {
    const schoolId = res.locals.schoolId!;
    const school = await getSchoolById(schoolId);
    if (!school?.classpilotEmailMonitoring) {
      return res.status(400).json({ error: "Email monitoring not enabled" });
    }

    const students = await getStudentsBySchool(schoolId);
    const withEmail = students.filter((s) => s.email);
    const existingWatches = await getMailpilotWatchesBySchool(schoolId);
    const existingByEmail = new Map(existingWatches.map((w) => [w.studentEmail.toLowerCase(), w]));
    const currentStudentEmails = new Set(withEmail.map((s) => s.email!.toLowerCase()));

    let added = 0;
    let removed = 0;
    const concurrency = 5;

    // Stop watches for students no longer in the roster
    const toRemove = existingWatches.filter((w) => !currentStudentEmails.has(w.studentEmail.toLowerCase()));
    const removeQueue = [...toRemove];
    async function removeWorker() {
      while (removeQueue.length > 0) {
        const w = removeQueue.shift();
        if (!w) continue;
        try { await stopWatch(w.studentEmail); } catch { /* best effort */ }
        await deleteMailpilotWatch(w.studentEmail);
        removed++;
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => removeWorker()));

    // Start watches for new students
    const toAdd = withEmail.filter((s) => !existingByEmail.has(s.email!.toLowerCase()));
    const addQueue = [...toAdd];
    async function addWorker() {
      while (addQueue.length > 0) {
        const s = addQueue.shift();
        if (!s || !s.email) continue;
        try {
          const result = await startWatch(s.email);
          await upsertMailpilotWatch({
            schoolId,
            studentId: s.id,
            studentEmail: s.email.toLowerCase(),
            historyId: result.historyId,
            expiresAt: result.expiration,
            status: "active",
          });
          added++;
        } catch (err) {
          console.error(`[MailPilot] resync startWatch failed for ${s.email}:`, (err as Error).message);
        }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => addWorker()));

    return res.json({ added, removed, totalActive: existingWatches.length + added - removed });
  } catch (err) {
    next(err);
  }
});

function safeParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
