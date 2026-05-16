import { describe, expect, it } from "vitest";
import type { School } from "../src/schema/core.js";
import {
  normalizeStudentEmail,
  selectSchoolForStudentEmail,
} from "../src/services/studentIdentity.js";

function school(id: string, domain = "example.edu"): School {
  return { id, name: id, domain } as School;
}

describe("student identity resolution helpers", () => {
  it("normalizes student email and extracts the domain", () => {
    expect(normalizeStudentEmail(" Student@Example.EDU ")).toEqual({
      emailLc: "student@example.edu",
      domain: "example.edu",
    });
    expect(normalizeStudentEmail("not-an-email")).toBeUndefined();
  });

  it("selects the only matching school for a unique Workspace domain", () => {
    expect(selectSchoolForStudentEmail([school("school-1")])).toEqual({
      school: school("school-1"),
      isSharedDomain: false,
    });
  });

  it("requires an imported student match when multiple schools share a domain", () => {
    const matches = [school("north"), school("south")];

    expect(selectSchoolForStudentEmail(matches)).toBeUndefined();
    expect(selectSchoolForStudentEmail(matches, "south")).toEqual({
      school: school("south"),
      isSharedDomain: true,
    });
    expect(selectSchoolForStudentEmail(matches, "unknown")).toBeUndefined();
  });
});
