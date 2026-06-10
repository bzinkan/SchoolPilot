import { hashPassword } from "./password.js";
import type { UpdateSchoolData } from "../schema/validation.js";

/**
 * Convert validated school-update input into a storage payload: the plaintext
 * kioskPin (input-only field) becomes a bcrypt kioskPinHash, and never reaches
 * the database or logs as-is. kioskPin === null clears the PIN.
 */
export async function toSchoolUpdate(
  data: UpdateSchoolData
): Promise<Omit<UpdateSchoolData, "kioskPin"> & { kioskPinHash?: string | null }> {
  const { kioskPin, ...rest } = data;
  if (kioskPin === undefined) return rest;
  return {
    ...rest,
    kioskPinHash: kioskPin === null ? null : await hashPassword(kioskPin),
  };
}
