import { randomInt, timingSafeEqual } from "crypto";
import type { Student } from "../schema/students.js";
import { comparePassword, hashPassword } from "../util/password.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

export type GeneratedClassPilotPin = {
  studentId: string;
  studentName: string;
  gradeLevel: string | null;
  pin: string;
};

export function randomFourDigitClassPilotPin(usedPins?: Set<string>): string {
  if (usedPins && usedPins.size >= 10000) {
    throw new Error("No unique PINs available");
  }

  let pin = "";
  do {
    pin = String(randomInt(0, 10000)).padStart(4, "0");
  } while (usedPins?.has(pin));
  usedPins?.add(pin);
  return pin;
}

export async function hashClassPilotPin(pin: string): Promise<string> {
  return hashPassword(pin);
}

export function encryptClassPilotPin(pin: string): string {
  return encryptSecret(pin);
}

export function decryptClassPilotPin(encryptedPin: string | null | undefined): string | null {
  if (!encryptedPin) return null;
  try {
    const pin = decryptSecret(encryptedPin);
    return /^\d{4}$/.test(pin) ? pin : null;
  } catch {
    return null;
  }
}

export const CLASSPILOT_PIN_VERIFY_MODE_ENV = "CLASSPILOT_PIN_VERIFY_MODE";
export type ClassPilotPinVerifyMode = "encrypted" | "bcrypt";

export type ClassPilotPinVerification =
  | { ok: true; via: "encrypted" | "bcrypt"; backfillEncrypted?: string }
  | { ok: false; reason: "PIN_NOT_CONFIGURED" | "PIN_MISMATCH" };

export type ClassPilotPinCredential = Pick<Student, "classpilotPinHash" | "classpilotPinEncrypted">;

export function classpilotPinVerifyMode(env: NodeJS.ProcessEnv = process.env): ClassPilotPinVerifyMode {
  return env[CLASSPILOT_PIN_VERIFY_MODE_ENV] === "bcrypt" ? "bcrypt" : "encrypted";
}

function pinsMatch(entered: string, expected: string): boolean {
  // Both values are exactly four ASCII digits here; equal lengths keep the
  // comparison constant time.
  const enteredBuffer = Buffer.from(entered, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return enteredBuffer.length === expectedBuffer.length && timingSafeEqual(enteredBuffer, expectedBuffer);
}

/**
 * Verify a student's shared Chromebook PIN.
 *
 * The admin-visible PIN (`classpilotPinEncrypted`, AES-256-GCM) is the source
 * of truth: it is what a teacher reads out to the student, and every PIN write
 * path stores it alongside the bcrypt hash. Decrypting it and comparing in
 * constant time costs microseconds, where the bcrypt compare costs ~0.9 s of
 * event-loop CPU on a half-vCPU task. bcrypt is used only for rows that have no
 * decryptable PIN (legacy rows, or an undecryptable ciphertext); a successful
 * bcrypt verification returns the ciphertext the caller should backfill so the
 * next sign-in is fast. A decrypted PIN that does not match is a mismatch — the
 * bcrypt hash is never consulted afterwards, because that would put the ~0.9 s
 * back on every wrong PIN.
 *
 * `CLASSPILOT_PIN_VERIFY_MODE=bcrypt` forces the legacy path (kill switch).
 */
export async function verifyClassPilotPin(
  student: ClassPilotPinCredential,
  enteredPin: string,
  options: {
    env?: NodeJS.ProcessEnv;
    compare?: (pin: string, hash: string) => Promise<boolean>;
  } = {}
): Promise<ClassPilotPinVerification> {
  if (!/^\d{4}$/.test(enteredPin)) return { ok: false, reason: "PIN_MISMATCH" };
  const compare = options.compare ?? comparePassword;
  const storedPin = classpilotPinVerifyMode(options.env) === "encrypted"
    ? decryptClassPilotPin(student.classpilotPinEncrypted)
    : null;
  if (storedPin !== null) {
    return pinsMatch(enteredPin, storedPin)
      ? { ok: true, via: "encrypted" }
      : { ok: false, reason: "PIN_MISMATCH" };
  }
  if (!student.classpilotPinHash) return { ok: false, reason: "PIN_NOT_CONFIGURED" };
  if (!(await compare(enteredPin, student.classpilotPinHash))) {
    return { ok: false, reason: "PIN_MISMATCH" };
  }
  return student.classpilotPinEncrypted
    ? { ok: true, via: "bcrypt" }
    : { ok: true, via: "bcrypt", backfillEncrypted: encryptClassPilotPin(enteredPin) };
}

export function generatedPinForStudent(
  student: Pick<Student, "id" | "firstName" | "lastName" | "email" | "gradeLevel">,
  pin: string
): GeneratedClassPilotPin {
  return {
    studentId: student.id,
    studentName: `${student.firstName || ""} ${student.lastName || ""}`.trim() || student.email || "Student",
    gradeLevel: student.gradeLevel || null,
    pin,
  };
}
