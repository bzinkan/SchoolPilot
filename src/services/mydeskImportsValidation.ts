import { z } from "zod";
import { readMyDeskModes } from "../config/mydeskModes.js";
import {
  myDeskCategory,
  myDeskDate,
  myDeskId,
} from "./mydeskValidation.js";
export const IMPORT_MAX_SOURCES = 5,
  IMPORT_MAX_PAGES = 20,
  IMPORT_MAX_ITEMS = 50,
  IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_UPLOAD_MS = 24 * 3600_000,
  IMPORT_REVIEW_MS = 7 * 24 * 3600_000,
  IMPORT_LEASE_MS = 5 * 60_000;
function dailyLimit(name: string, fallback: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw Object.assign(
      new Error("Paperwork import is temporarily unavailable"),
      {
        status: 503,
        code: "MYDESK_IMPORT_CONFIGURATION",
        expose: true,
      },
    );
  }
  return value;
}
/** The notice and admission guard use one parser, including configured quota overrides. */
export function myDeskImportLimits() {
  return {
    maxSources: IMPORT_MAX_SOURCES,
    maxSourceBytes: IMPORT_MAX_BYTES,
    maxPages: IMPORT_MAX_PAGES,
    maxForms: IMPORT_MAX_ITEMS,
    teacherDailyPages: dailyLimit(
      "MYDESK_AI_IMPORT_TEACHER_DAILY_PAGES",
      100,
      10000,
    ),
    schoolDailyPages: dailyLimit(
      "MYDESK_AI_IMPORT_SCHOOL_DAILY_PAGES",
      500,
      100000,
    ),
    uploadExpiryHours: IMPORT_UPLOAD_MS / 3600_000,
    reviewExpiryDays: IMPORT_REVIEW_MS / (24 * 3600_000),
  };
}
export function myDeskImportsEnabledForSchool(schoolId: string) {
  return Boolean(schoolId) && readMyDeskModes().aiImportMode === "on";
}
const uuid = z.string().uuid();
export const importMutation = z
  .object({ requestId: uuid, revision: z.number().int().positive() })
  .strict();
const groups = z
  .array(myDeskId)
  .min(1)
  .max(20)
  .refine((v) => new Set(v).size === v.length, "Choose distinct classes");
export const importCreate = z
  .object({
    clientRequestId: uuid,
    selectedGroupIds: groups,
    expectedSourceCount: z.number().int().min(1).max(IMPORT_MAX_SOURCES),
  })
  .strict();
export const importFromAttachment = z.object({
  clientRequestId: uuid,
  noteId: myDeskId,
  attachmentId: myDeskId,
  selectedGroupIds: groups,
}).strict();
export const importUpdate = importMutation
  .extend({
    selectedGroupIds: groups.optional(),
    pageDecisions: z
      .array(z.object({ assetId: uuid, excluded: z.boolean() }).strict())
      .max(20)
      .optional(),
  })
  .strict();
export const importRegion = z
  .object({
    assetId: uuid,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
    rotation: z.union([
      z.literal(0),
      z.literal(90),
      z.literal(180),
      z.literal(270),
    ]),
  })
  .strict()
  .refine(
    (r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001,
    "Keep the form inside its page",
  );
export const importItemCreate = importMutation
  .extend({ regions: z.array(importRegion).min(1).max(20) })
  .strict();
export const importItemJoin = importMutation
  .extend({
    itemRevision: z.number().int().positive(),
    sourceItemId: uuid,
    sourceItemRevision: z.number().int().positive(),
  })
  .strict();
export const importItemUpdate = importMutation
  .extend({
    itemRevision: z.number().int().positive(),
    regions: z.array(importRegion).max(20).optional(),
    groupId: myDeskId.nullable().optional(),
    studentId: myDeskId.nullable().optional(),
    rosterRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    category: myDeskCategory.optional(),
    title: z.string().trim().max(160).optional(),
    body: z.string().trim().max(5000).optional(),
    entryDate: myDeskDate.nullable().optional(),
    reviewed: z.boolean().optional(),
    excluded: z.boolean().optional(),
  })
  .strict();
export const importCommit = importMutation
  .extend({
    itemIds: z
      .array(uuid)
      .min(1)
      .max(50)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose distinct forms",
      ),
  })
  .strict();
export const importReservation = z
  .object({
    clientRequestId: uuid,
    filename: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((v) => !/[\u0000-\u001f\u007f/\\]/.test(v), "Invalid filename"),
    contentType: z.enum([
      "application/pdf",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    size: z.number().int().positive().max(IMPORT_MAX_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
