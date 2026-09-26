export default function StudentContactFields({
  contact,
  onChange,
  disabled = false,
}) {
  const change = (key, value) => onChange({ ...contact, [key]: value });
  return (
    <fieldset className="student-info-contact" disabled={disabled}>
      <legend>{contact.name || "Contact"}</legend>
      <label>
        Contact name
        <input
          required
          maxLength={200}
          value={contact.name}
          onChange={(e) => change("name", e.target.value)}
        />
      </label>
      <label>
        Relationship as stated
        <input
          maxLength={100}
          value={contact.relationship || ""}
          onChange={(e) => change("relationship", e.target.value || null)}
        />
      </label>
      <label>
        Phone numbers, one per line
        <textarea
          rows={2}
          value={contact.phones.join("\n")}
          onChange={(e) =>
            change("phones", e.target.value.split("\n").filter(Boolean))
          }
          inputMode="tel"
        />
      </label>
      <label>
        Email addresses, one per line
        <textarea
          rows={2}
          value={contact.emails.join("\n")}
          onChange={(e) =>
            change("emails", e.target.value.split("\n").filter(Boolean))
          }
        />
      </label>
      <label>
        Preferred contact
        <select
          value={contact.preferred == null ? "" : String(contact.preferred)}
          onChange={(e) =>
            change(
              "preferred",
              e.target.value === "" ? null : e.target.value === "true",
            )
          }
        >
          <option value="">Not stated</option>
          <option value="true">Yes, explicitly stated</option>
          <option value="false">No, explicitly stated</option>
        </select>
      </label>
      <label>
        Emergency contact
        <select
          value={contact.emergency == null ? "" : String(contact.emergency)}
          onChange={(e) =>
            change(
              "emergency",
              e.target.value === "" ? null : e.target.value === "true",
            )
          }
        >
          <option value="">Not stated</option>
          <option value="true">Yes, explicitly stated</option>
          <option value="false">No, explicitly stated</option>
        </select>
      </label>
      <label>
        Preferred contact method
        <input
          maxLength={80}
          value={contact.preferredMethod || ""}
          onChange={(e) => change("preferredMethod", e.target.value || null)}
        />
      </label>
      <label>
        Preferred language
        <input
          maxLength={100}
          value={contact.language || ""}
          onChange={(e) => change("language", e.target.value || null)}
        />
      </label>
    </fieldset>
  );
}
