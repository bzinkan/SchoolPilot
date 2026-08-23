import { and, eq } from "drizzle-orm";
import db from "../db.js";
import { classpilotEvidenceCaptureRequests } from "../schema/classpilot.js";
import { evidenceArtifacts } from "../schema/shared.js";
import { screenshotBindingVersion } from "../realtime/ws-redis.js";
import {
  assertClasspilotScreenshotEvidenceAuthority,
  classpilotEvidenceUrlDigest,
} from "./classpilotEvidenceAuthority.js";

export const CLASSPILOT_EVIDENCE_CAPTURE_TTL_MS = 30_000;
const CAPTURE_CLOCK_SKEW_MS = 5_000;

type ExactBinding = {
  schoolId: string;
  deviceId: string;
  studentId: string;
  studentSessionId: string;
};

function exactScreenshotArtifactAuthority(
  binding: ExactBinding,
  capturedAt: Date
) {
  const authority = {
    artifactType: "screenshot" as const,
    schoolId: binding.schoolId,
    deviceId: binding.deviceId,
    studentId: binding.studentId,
    studentSessionId: binding.studentSessionId,
    bindingVersion: screenshotBindingVersion(binding),
    capturedAt,
  };
  assertClasspilotScreenshotEvidenceAuthority(authority);
  return authority;
}

export async function createClasspilotEvidenceCaptureRequest(input: ExactBinding & {
  teachingSessionId: string | null;
  caseId: string | null;
  heartbeatId: string;
  tabRef: string;
  tabSnapshotRevision: number;
  expectedUrl: string;
  now?: Date;
}): Promise<{ requestId: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + CLASSPILOT_EVIDENCE_CAPTURE_TTL_MS);
  const [request] = await db.insert(classpilotEvidenceCaptureRequests).values({
    schoolId: input.schoolId,
    deviceId: input.deviceId,
    studentId: input.studentId,
    studentSessionId: input.studentSessionId,
    teachingSessionId: input.teachingSessionId,
    caseId: input.caseId,
    heartbeatId: input.heartbeatId,
    tabRef: input.tabRef,
    tabSnapshotRevision: input.tabSnapshotRevision,
    expectedUrlDigest: classpilotEvidenceUrlDigest(input.expectedUrl),
    status: "pending",
    requestedAt: now,
    expiresAt,
  }).returning({ id: classpilotEvidenceCaptureRequests.id });
  if (!request) throw new Error("Evidence capture request was not created");
  return { requestId: request.id, expiresAt: expiresAt.toISOString() };
}

export type CompleteEvidenceCaptureResult =
  | { status: "uploaded"; artifactId: string; duplicate: boolean }
  | {
      status: "unavailable";
      reason: "not_found" | "expired" | "tab_mismatch" | "stale_capture" | "invalid_image";
    };
type EvidenceUnavailableReason = Extract<
  CompleteEvidenceCaptureResult,
  { status: "unavailable" }
>["reason"];

function imageContentType(screenshot: string): string | null {
  const match = /^data:image\/(jpeg|png|webp);base64,/i.exec(screenshot);
  return match ? `image/${match[1]!.toLowerCase()}` : null;
}

export async function completeClasspilotEvidenceCaptureRequest(input: ExactBinding & {
  requestId: string;
  tabRef: string;
  tabSnapshotRevision: number;
  tabUrl: string;
  tabTitle?: string;
  screenshot: string;
  capturedAt: Date;
  now?: Date;
}): Promise<CompleteEvidenceCaptureResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(classpilotEvidenceCaptureRequests)
      .where(and(
        eq(classpilotEvidenceCaptureRequests.id, input.requestId),
        eq(classpilotEvidenceCaptureRequests.schoolId, input.schoolId),
        eq(classpilotEvidenceCaptureRequests.studentId, input.studentId),
        eq(classpilotEvidenceCaptureRequests.studentSessionId, input.studentSessionId),
        eq(classpilotEvidenceCaptureRequests.deviceId, input.deviceId)
      ))
      .limit(1)
      .for("update");
    if (!request) return { status: "unavailable", reason: "not_found" } as const;
    if (request.status === "uploaded" && request.artifactId) {
      return { status: "uploaded", artifactId: request.artifactId, duplicate: true } as const;
    }
    if (request.status !== "pending") {
      return {
        status: "unavailable",
        reason: request.status === "expired" ? "expired" : "stale_capture",
      } as const;
    }

    const type = imageContentType(input.screenshot);
    let failure: EvidenceUnavailableReason | null = null;
    if (request.expiresAt.getTime() <= now.getTime()) failure = "expired";
    else if (
      request.tabRef !== input.tabRef
      || request.tabSnapshotRevision !== input.tabSnapshotRevision
      || request.expectedUrlDigest !== classpilotEvidenceUrlDigest(input.tabUrl)
    ) failure = "tab_mismatch";
    else if (
      !Number.isFinite(input.capturedAt.getTime())
      || input.capturedAt.getTime() < request.requestedAt.getTime() - CAPTURE_CLOCK_SKEW_MS
      || input.capturedAt.getTime() > request.expiresAt.getTime() + CAPTURE_CLOCK_SKEW_MS
      || input.capturedAt.getTime() > now.getTime() + CAPTURE_CLOCK_SKEW_MS
    ) failure = "stale_capture";
    else if (!type) failure = "invalid_image";

    if (failure) {
      const [artifact] = await tx.insert(evidenceArtifacts).values({
        ...exactScreenshotArtifactAuthority(input, now),
        caseId: request.caseId,
        sourceType: "classpilot_safety_capture",
        sourceId: request.id,
        status: "unavailable",
        label: "Safety screenshot unavailable",
        contentType: null,
        content: null,
        metadata: {
          captureRequestId: request.id,
          unavailableReason: failure,
        },
      }).returning({ id: evidenceArtifacts.id });
      await tx.update(classpilotEvidenceCaptureRequests).set({
        status: failure === "expired" ? "expired" : "failed",
        artifactId: artifact?.id ?? null,
        completedAt: now,
      }).where(eq(classpilotEvidenceCaptureRequests.id, request.id));
      return { status: "unavailable", reason: failure } as const;
    }

    const [artifact] = await tx.insert(evidenceArtifacts).values({
      ...exactScreenshotArtifactAuthority(input, input.capturedAt),
      caseId: request.caseId,
      sourceType: "classpilot_safety_capture",
      sourceId: request.id,
      status: "available",
      label: "Exact-tab safety screenshot",
      contentType: type,
      content: input.screenshot,
      metadata: {
        captureRequestId: request.id,
        tabRef: request.tabRef,
        tabSnapshotRevision: request.tabSnapshotRevision,
        capturedFromExactBinding: true,
      },
    }).returning({ id: evidenceArtifacts.id });
    if (!artifact) throw new Error("Evidence artifact was not created");
    await tx.update(classpilotEvidenceCaptureRequests).set({
      status: "uploaded",
      artifactId: artifact.id,
      completedAt: now,
    }).where(eq(classpilotEvidenceCaptureRequests.id, request.id));
    return { status: "uploaded", artifactId: artifact.id, duplicate: false } as const;
  });
}
