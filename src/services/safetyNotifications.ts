import { sql } from "drizzle-orm";
import { schedulerDb } from "./schedulerDb.js";
import { resolveClasspilotEntitlement } from "./classpilotEntitlement.js";
import { sendEmailWithResult, type EmailSendResult, type EmailSendOptions } from "./email.js";
import type db from "../db.js";
import { recordRuntimePerformanceCounter } from "./runtimePerformanceMetrics.js";
import { sendSafetyEmailBounded } from "./safetyEmailTransport.js";
import { SAFETY_NOTIFICATION_BUNDLES_PER_PASS, safetyEmailText, safetyNotificationBundleKey, safetyNotificationRetry } from "./safetyNotificationModel.js";
export { safetyEmailText, safetyNotificationRetry } from "./safetyNotificationModel.js";

type Row=Record<string,any>;
function reservationBusy(error: unknown): boolean {
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth++) {
    if ((current as { code?: string }).code === "55P03") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
/**
 * Reservation is recoverable. Committing submission_started_at under the same
 * URL/case locks as review is the submission authorization point. Reviews before
 * that commit cancel delivery; after it the message is in flight and cannot be
 * recalled. No transaction or review lock is held while calling the provider.
 */
export async function dispatchSafetyNotifications(options:{send?:(message:EmailSendOptions)=>Promise<EmailSendResult>;providerConfigured?:boolean}={}) {
  await schedulerDb.execute(sql`UPDATE safety_notification_outbox o SET status='cancelled',completed_at=now(),error_code='INITIAL_NOT_DELIVERABLE'
    WHERE o.kind='followup' AND o.status='pending' AND EXISTS(SELECT 1 FROM safety_notification_outbox i
      WHERE i.school_id=o.school_id AND i.alert_id=o.alert_id AND i.recipient=o.recipient AND i.kind='initial' AND i.status IN ('failed','cancelled'))`);
  await schedulerDb.execute(sql`UPDATE safety_notification_outbox SET
    status=CASE WHEN submission_started_at IS NULL THEN 'pending' ELSE 'unknown' END,
    completed_at=CASE WHEN submission_started_at IS NULL THEN NULL ELSE now() END,
    error_code=CASE WHEN submission_started_at IS NULL THEN 'WORKER_INTERRUPTED_BEFORE_SUBMISSION' ELSE 'WORKER_INTERRUPTED_AFTER_SUBMISSION' END,
    claimed_at=NULL
    WHERE status='sending' AND claimed_at<now()-interval '10 minutes'`);
  const claimed=await schedulerDb.transaction(async tx=>{
    // transaction_timestamp() is one fixed cutoff for the entire reservation pass.
    // Limit message groups, never their alert rows: row limits split an existing
    // student/recipient cohort into unnecessary additional emails.
    const candidates=(await tx.execute(sql`SELECT o.school_id,o.recipient,o.kind,
      CASE WHEN o.kind='initial' THEN o.case_id ELSE NULL END AS bundle_case_id,min(o.due_at) AS oldest_due
      FROM safety_notification_outbox o
      WHERE o.status='pending' AND o.due_at<=now()
      AND (o.kind='initial' OR EXISTS(SELECT 1 FROM safety_notification_outbox i WHERE i.school_id=o.school_id AND i.alert_id=o.alert_id AND i.recipient=o.recipient AND i.kind='initial' AND i.status IN ('sent','unknown')))
      GROUP BY o.school_id,o.recipient,o.kind,bundle_case_id
      ORDER BY oldest_due,o.school_id,o.recipient,o.kind,bundle_case_id
      LIMIT ${SAFETY_NOTIFICATION_BUNDLES_PER_PASS}`)).rows as Row[];
    const reserved: Row[] = [];
    for (const candidate of candidates) {
      const key = safetyNotificationBundleKey({...candidate,case_id:candidate.bundle_case_id});
      const locked=(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`safety-notification-bundle:${key}`},0)) AS locked`)).rows as Row[];
      if (!locked[0]?.locked) continue;
      try {
        const cohort = await tx.transaction(async bundleTx => {
          // A review may hold one outbox row. NOWAIT plus the savepoint skips the
          // whole cohort instead of splitting it or reversing review lock order.
          const entries=(await bundleTx.execute(sql`SELECT o.id FROM safety_notification_outbox o
            WHERE o.school_id=${candidate.school_id} AND o.recipient=${candidate.recipient} AND o.kind=${candidate.kind}
              AND (CASE WHEN o.kind='initial' THEN o.case_id ELSE NULL END) IS NOT DISTINCT FROM ${candidate.bundle_case_id}
              AND o.status='pending' AND o.due_at<=transaction_timestamp()
              AND (o.kind='initial' OR EXISTS(SELECT 1 FROM safety_notification_outbox i WHERE i.school_id=o.school_id AND i.alert_id=o.alert_id AND i.recipient=o.recipient AND i.kind='initial' AND i.status IN ('sent','unknown')))
            ORDER BY o.id FOR UPDATE OF o NOWAIT`)).rows as Row[];
          if (!entries.length) return [];
          return (await bundleTx.execute(sql`UPDATE safety_notification_outbox SET status='sending',claimed_at=now(),submission_started_at=NULL
            WHERE school_id=${candidate.school_id} AND id=ANY(${sql.param(entries.map(entry=>entry.id))}::text[]) RETURNING *`)).rows as Row[];
        });
        for (const entry of cohort) reserved.push(entry);
      } catch(error) { if (!reservationBusy(error)) throw error; }
    }
    return reserved;
  });
  const bundles=new Map<string,Row[]>();
  for(const entry of claimed) {
    const key=safetyNotificationBundleKey(entry);
    const bundle=bundles.get(key)||[];bundle.push(entry);bundles.set(key,bundle);
  }
  for(const entries of bundles.values()) {
    const first=entries[0]; if (!first) continue;
    const schoolId=String(first.school_id);const recipient=String(first.recipient);
    const eligible=await schedulerDb.transaction(async tx=>{
      const entitlement=await resolveClasspilotEntitlement(schoolId,tx as unknown as typeof db,{lock:true});
      const members=(await tx.execute(sql`SELECT m.id FROM school_memberships m JOIN users u ON u.id=m.user_id
        WHERE m.school_id=${schoolId} AND m.status='active' AND m.role IN ('admin','school_admin')
        AND lower(trim(u.email))=${recipient} ORDER BY m.id FOR SHARE OF m,u`)).rows;
      // Same order as observation/review: URL, case, alert, outbox. Sort bundles
      // to keep simultaneous workers from locking shared rows in opposite order.
      const fingerprints=(await tx.execute(sql`SELECT DISTINCT a.url_fingerprint FROM student_safety_alerts a
        WHERE a.school_id=${schoolId} AND a.id=ANY(${sql.param(entries.map(e=>e.alert_id))}::text[])
        AND a.url_fingerprint IS NOT NULL ORDER BY a.url_fingerprint`)).rows as Row[];
      for(const item of fingerprints) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`safety-url:${schoolId}:${item.url_fingerprint}`},0))`);
      await tx.execute(sql`SELECT id FROM student_safety_cases WHERE school_id=${schoolId}
        AND id=ANY(${sql.param(entries.map(e=>e.case_id))}::text[]) ORDER BY id FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM student_safety_alerts WHERE school_id=${schoolId}
        AND id=ANY(${sql.param(entries.map(e=>e.alert_id))}::text[]) ORDER BY id FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM safety_notification_outbox WHERE school_id=${schoolId}
        AND id=ANY(${sql.param(entries.map(e=>e.id))}::text[]) ORDER BY id FOR UPDATE`);
      const eligible=entitlement.entitled&&members.length?(await tx.execute(sql`SELECT o.*,a.concern,a.severity,a.reason,a.first_seen_at,s.first_name,s.last_name,
      COALESCE(sc.school_timezone,'America/New_York') AS timezone
      FROM safety_notification_outbox o JOIN student_safety_alerts a ON a.school_id=o.school_id AND a.id=o.alert_id
      JOIN student_safety_cases c ON c.school_id=o.school_id AND c.id=o.case_id
      JOIN students s ON s.school_id=a.school_id AND s.id=a.student_id JOIN schools sc ON sc.id=o.school_id
      WHERE o.school_id=${schoolId} AND o.id=ANY(${sql.param(entries.map(e=>e.id))}::text[]) AND o.status='sending' AND o.submission_started_at IS NULL
      AND c.status='open' AND a.reviewed_at IS NULL
      AND (o.kind='initial' OR a.acknowledged_at IS NULL)
      AND (a.source_type<>'mailpilot' OR (sc.mailpilot_entitled=true AND sc.classpilot_email_monitoring=true))
      AND NOT EXISTS(SELECT 1 FROM safety_url_exceptions e WHERE e.school_id=a.school_id AND e.fingerprint=a.url_fingerprint AND e.revoked_at IS NULL)
      ORDER BY o.due_at,o.id`)).rows as Row[]:[];
      const eligibleIds=new Set(eligible.map(e=>e.id));
      const cancelledIds=entries.filter(e=>!eligibleIds.has(e.id)).map(e=>e.id);
      if(cancelledIds.length) await tx.execute(sql`UPDATE safety_notification_outbox SET status='cancelled',completed_at=now()
        WHERE id=ANY(${sql.param(cancelledIds)}::text[]) AND school_id=${schoolId} AND status='sending' AND submission_started_at IS NULL`);
      if(eligible.length) await tx.execute(sql`UPDATE safety_notification_outbox SET submission_started_at=now(),claimed_at=now(),attempts=attempts+1
        WHERE school_id=${schoolId} AND id=ANY(${sql.param(eligible.map(e=>e.id))}::text[])`);
      return eligible.map((entry):Row=>({...entry,attempts:entry.attempts+1}));
    });
    if(!eligible.length) continue;
    const origin=process.env.PUBLIC_APP_URL||process.env.APP_URL||'https://school-pilot.net';
    // Missing provider configuration is not evidence that a safety notification was sent.
    const result:EmailSendResult=(options.providerConfigured??Boolean(process.env.SENDGRID_API_KEY))
      ?await sendSafetyEmailBounded(options.send??sendEmailWithResult,{to:recipient,subject:first.kind==='followup'?'ClassPilot: unacknowledged student safety alerts':'ClassPilot: student safety report',text:safetyEmailText(eligible,eligible[0]?.timezone||'America/New_York',origin),customArgs:{workflow:'safety-center-v1'}})
      :{status:'transient_failure',error:'EMAIL_PROVIDER_UNCONFIGURED'};
    recordRuntimePerformanceCounter(result.status==='sent'?(first.kind==='followup'?'safetyFollowupsSent':'safetyEmailsSent'):result.status==='unknown'?'safetyEmailUnknown':'safetyEmailFailures');
    const outcomes=new Map<string,{status:string;delaySeconds:number;ids:string[]}>();
    for(const entry of eligible) {
      const outcome=safetyNotificationRetry(entry.attempts,result.status);
      const key=JSON.stringify(outcome),group=outcomes.get(key)||{...outcome,ids:[]};group.ids.push(entry.id);outcomes.set(key,group);
    }
    // At most the retry-attempt buckets: no per-alert round trips after transport.
    for(const outcome of outcomes.values()) {
      await schedulerDb.execute(sql`UPDATE safety_notification_outbox SET status=${outcome.status},
        due_at=CASE WHEN ${outcome.status}='pending' THEN now()+${outcome.delaySeconds}*interval '1 second' ELSE due_at END,
        completed_at=CASE WHEN ${outcome.status}='pending' THEN NULL ELSE now() END,
        submission_started_at=CASE WHEN ${outcome.status}='pending' THEN NULL ELSE submission_started_at END,
        provider_message_id=${result.status==='sent'?result.providerMessageId??null:null},
        error_code=${result.status==='sent'?null:result.error.slice(0,120)}
        WHERE school_id=${schoolId} AND id=ANY(${sql.param(outcome.ids)}::text[]) AND status='sending'`);
    }
  }
}
