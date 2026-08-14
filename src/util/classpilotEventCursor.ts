export type ClasspilotEventCursor = { occurredAt: Date; id: string };

export function encodeClasspilotEventCursor(cursor: ClasspilotEventCursor): string {
  return Buffer.from(JSON.stringify({
    t: cursor.occurredAt.toISOString(),
    i: cursor.id,
  }), "utf8").toString("base64url");
}

export function decodeClasspilotEventCursor(value: unknown): ClasspilotEventCursor | undefined {
  if (typeof value !== "string" || value.length > 512) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const occurredAt = new Date(String(parsed.t || ""));
    const id = String(parsed.i || "");
    if (!Number.isFinite(occurredAt.getTime()) || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) return undefined;
    return { occurredAt, id };
  } catch {
    return undefined;
  }
}

export function formulaSafeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  // Spreadsheet engines may ignore leading spaces/control characters before
  // deciding a cell is a formula, so inspect the first meaningful byte.
  if (/^[\u0000-\u0020]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
