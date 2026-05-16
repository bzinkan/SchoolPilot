import type { School } from "../schema/core.js";

export interface NormalizedStudentEmail {
  emailLc: string;
  domain: string;
}

export function normalizeStudentEmail(email: string): NormalizedStudentEmail | undefined {
  const emailLc = email.trim().toLowerCase();
  const domain = emailLc.split("@")[1];
  if (!emailLc || !domain) return undefined;
  return { emailLc, domain };
}

export function selectSchoolForStudentEmail(
  matchingSchools: School[],
  studentSchoolId?: string | null
): { school: School; isSharedDomain: boolean } | undefined {
  if (matchingSchools.length === 0) return undefined;
  if (matchingSchools.length === 1) {
    return { school: matchingSchools[0]!, isSharedDomain: false };
  }

  if (!studentSchoolId) return undefined;
  const school = matchingSchools.find((s) => s.id === studentSchoolId);
  return school ? { school, isSharedDomain: true } : undefined;
}
