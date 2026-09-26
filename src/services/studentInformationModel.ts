import { createHash } from "node:crypto";
import {
  contactProfile,
  informationError,
  type ContactChange,
  type ContactProfile,
} from "./studentInformationValidation.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const informationHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function applyContactChanges(
  existing: ContactProfile,
  changes: ContactChange[],
): ContactProfile {
  const result = structuredClone(existing);
  for (const change of changes) {
    if (change.kind === "add") {
      const found = result.contacts.find((c) => c.id === change.contact.id);
      if (found && informationHash(found) !== informationHash(change.contact))
        throw informationError(
          409,
          "CONTACT_CONFLICT",
          "A contact identifier is already in use",
        );
      if (!found) result.contacts.push(structuredClone(change.contact));
    } else {
      const index = result.contacts.findIndex((c) => c.id === change.contactId);
      if (index < 0)
        throw informationError(
          409,
          "CONTACT_CHANGED",
          "This contact changed. Review the current profile",
        );
      if (change.kind === "remove") {
        result.contacts.splice(index, 1);
        continue;
      }
      const target = result.contacts[index]!;
      // Missing and blank source fields never erase a current value. Erasure is a
      // separate, explicit human decision, including empty phone/email arrays.
      for (const [key, value] of Object.entries(change.fields)) {
        if (
          value === null ||
          value === "" ||
          (Array.isArray(value) && !value.length)
        )
          continue;
        Object.assign(target, { [key]: structuredClone(value) });
      }
      for (const key of change.clearFields)
        Object.assign(target, {
          [key]: key === "phones" || key === "emails" ? [] : null,
        });
    }
  }
  return contactProfile.parse(result);
}
