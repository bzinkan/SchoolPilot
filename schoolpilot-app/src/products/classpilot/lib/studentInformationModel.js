export const studentInformationKeys = {
  root: (schoolId, viewerId) => [
    "mydesk-private",
    schoolId || "",
    viewerId || "",
    "student-information",
  ],
  profile: (schoolId, viewerId, studentId) => [
    ...studentInformationKeys.root(schoolId, viewerId),
    "profile",
    studentId,
  ],
};
export const emptyContact = () => ({
  id: crypto.randomUUID(),
  name: "",
  relationship: null,
  phones: [],
  emails: [],
  preferred: null,
  preferredMethod: null,
  language: null,
  emergency: null,
});
export function contactChanges(before, after) {
  const changes = [];
  for (const contact of before.contacts)
    if (!after.contacts.some((item) => item.id === contact.id))
      changes.push({ kind: "remove", contactId: contact.id });
  for (const contact of after.contacts) {
    const prior = before.contacts.find((item) => item.id === contact.id);
    if (!prior) {
      changes.push({ kind: "add", contact });
      continue;
    }
    const fields = {},
      clearFields = [];
    for (const key of [
      "name",
      "relationship",
      "phones",
      "emails",
      "preferred",
      "preferredMethod",
      "language",
      "emergency",
    ]) {
      if (JSON.stringify(prior[key]) === JSON.stringify(contact[key])) continue;
      if (
        key !== "name" &&
        (contact[key] == null ||
          contact[key] === "" ||
          (Array.isArray(contact[key]) && !contact[key].length))
      )
        clearFields.push(key);
      else fields[key] = contact[key];
    }
    if (Object.keys(fields).length || clearFields.length)
      changes.push({
        kind: "replace",
        contactId: contact.id,
        fields,
        clearFields,
      });
  }
  return changes;
}
export function sourceContactDecision(proposed, decision) {
  if (!decision || decision.kind === "keep") return null;
  const contact = decision.contact || proposed;
  if (decision.kind === "add") return { kind: "add", contact };
  if (!decision.contactId)
    throw new Error("Choose the current contact to replace.");
  const { id: _id, ...fields } = contact;
  return {
    kind: "replace",
    contactId: decision.contactId,
    fields,
    clearFields: [],
  };
}
export const informationMessage = (error) =>
  error?.response?.data?.error ||
  error?.message ||
  "Student information is temporarily unavailable.";
export const informationFileType = (file) =>
  file.type ||
  (/\.csv$/i.test(file.name)
    ? "text/csv"
    : /\.docx$/i.test(file.name)
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : /\.xlsx$/i.test(file.name)
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "");
