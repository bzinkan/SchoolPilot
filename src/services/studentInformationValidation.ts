import { z } from "zod";
import { readMyDeskModes } from "../config/mydeskModes.js";

export const informationError = (
  status: number,
  code: string,
  message: string,
) =>
  Object.assign(new Error(message), {
    status,
    code: `STUDENT_INFORMATION_${code}`,
  });
export const informationId = z.string().min(1).max(128);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
export const contactFields = z
  .object({
    name: z.string().trim().min(1).max(200),
    relationship: optionalText(100),
    phones: z.array(z.string().trim().min(1).max(80)).max(10),
    emails: z.array(z.string().trim().email().max(254)).max(10),
    preferred: z.boolean().nullable(),
    preferredMethod: optionalText(80),
    language: optionalText(100),
    emergency: z.boolean().nullable(),
  })
  .strict();
export const contact = contactFields.extend({ id: z.string().uuid() }).strict();
export const contactProfile = z
  .object({ contacts: z.array(contact).max(20) })
  .strict()
  .refine(
    (v) => new Set(v.contacts.map((c) => c.id)).size === v.contacts.length,
    "Contact identifiers must be unique",
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 60000,
    "A contact profile is too large",
  );
export const contactChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("add"), contact }).strict(),
  z
    .object({
      kind: z.literal("replace"),
      contactId: z.string().uuid(),
      fields: contactFields.partial(),
      clearFields: z
        .array(
          z.enum([
            "relationship",
            "phones",
            "emails",
            "preferred",
            "preferredMethod",
            "language",
            "emergency",
          ]),
        )
        .max(7)
        .default([]),
    })
    .strict(),
  z
    .object({ kind: z.literal("remove"), contactId: z.string().uuid() })
    .strict(),
]);
export type ContactProfile = z.infer<typeof contactProfile>;
export type ContactChange = z.infer<typeof contactChange>;
export const profileSaveInput = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().min(0),
    changes: z.array(contactChange).min(1).max(60),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export const informationSearch = z
  .object({
    q: z.string().trim().max(200).default(""),
    classId: informationId.optional(),
    gradeLevel: z.string().max(100).optional(),
    includeInactive: z.boolean().default(false),
    cursor: informationId.optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export const informationMutation = z
  .object({
    requestId: z.string().uuid(),
    revision: z.number().int().positive(),
  })
  .strict();
export const informationCreate = z
  .object({
    clientRequestId: z.string().uuid(),
    expectedSourceCount: z.number().int().min(1).max(5),
  })
  .strict();
export const INFORMATION_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
] as const;
export const informationReserve = z
  .object({
    clientRequestId: z.string().uuid(),
    filename: z.string().min(1).max(255),
    contentType: z.enum(INFORMATION_TYPES),
    size: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const informationProcess = informationMutation
  .extend({
    sectionIds: z.array(z.string().uuid()).min(1).max(100),
    acknowledgedWarnings: z.boolean(),
    confirmedProvider: z.literal(true),
  })
  .strict();
export const informationItemUpdate = informationMutation
  .extend({
    itemRevision: z.number().int().positive(),
    studentId: informationId.nullable(),
    baseRevision: z.number().int().min(0),
    changes: z.array(contactChange).max(60),
    reviewed: z.boolean(),
    excluded: z.boolean(),
    resolvedWarnings: z.boolean(),
  })
  .strict();
export const informationJoin = informationMutation
  .extend({
    itemRevision: z.number().int().positive(),
    sourceItemId: informationId,
    sourceItemRevision: z.number().int().positive(),
  })
  .strict();
export const informationManualItem = informationMutation
  .extend({ sourceSectionId: informationId, studentId: informationId })
  .strict();
export const extractedContact = contactFields
  .partial()
  .extend({ name: z.string().trim().min(1).max(200) })
  .strict();
export const extractionSchema = z
  .object({
    profiles: z
      .array(
        z
          .object({
            studentName: z.string().trim().min(1).max(200),
            studentIdentifier: z.string().max(128).nullable(),
            contacts: z.array(extractedContact).max(20),
            warnings: z
              .array(
                z.enum([
                  "uncertain_name",
                  "uncertain_phone",
                  "uncertain_email",
                  "uncertain_relationship",
                  "multiple_students",
                  "unsupported_content",
                ]),
              )
              .max(10),
          })
          .strict(),
      )
      .max(500),
  })
  .strict();
export const emptyContactFields = {
  relationship: null,
  phones: [],
  emails: [],
  preferred: null,
  preferredMethod: null,
  language: null,
  emergency: null,
};
export function studentInformationImportEnabled() {
  const value = process.env.STUDENT_INFORMATION_AI_IMPORT_MODE ?? "off";
  if (value !== "on" && value !== "off")
    throw informationError(
      503,
      "CONFIGURATION",
      "Student information import configuration is unavailable",
    );
  return value === "on" && readMyDeskModes().mode === "on";
}
export function requireInformationImport() {
  if (!studentInformationImportEnabled())
    throw informationError(
      403,
      "IMPORT_DISABLED",
      "Student information AI imports are not enabled",
    );
}
export const INFORMATION_LIMITS = {
  files: 5,
  bytesPerFile: 10 * 1024 * 1024,
  pages: 20,
  sheets: 5,
  rows: 500,
  columns: 50,
  profiles: 500,
  extractedBytes: 1024 * 1024,
  units: 20,
};

export const INFORMATION_PROMPT_VERSION = "student-information-20260928-v1";
