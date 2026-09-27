// Saved scheduling dates are authoritative. Never infer a school's year bounds.
export function schoolYearSummary(config, today) {
  const start = config?.yearStart, end = config?.yearEnd;
  const valid = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  if (!start && !end) return { status: "missing", label: "School year needs dates", detail: "Set the start and end dates so schedules and discipline reports use the same school year." };
  if (!valid(start) || !valid(end) || start > end) return { status: "invalid", label: "School year needs review", detail: "Both saved dates must be valid, with the end on or after the start." };
  if (!valid(today)) return { status: "unknown", label: "School year saved", detail: "The school's current date is unavailable. Open School year to review the saved range.", start, end };
  if (today > end) return { status: "ended", label: "Configured school year has ended", detail: "Review the dates for the next school year. Previous records keep their original dates.", start, end };
  if (today < start) return { status: "upcoming", label: "Upcoming school year", detail: "Today is before the configured school year.", start, end };
  return { status: "current", label: "Current school year", detail: "Today falls within the configured school year.", start, end };
}

export function formatSchoolDate(value) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}
