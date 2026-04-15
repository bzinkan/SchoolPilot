import { google, type gmail_v1 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

let cachedSaCredentials: { client_email: string; private_key: string } | null = null;
let cachedSaClientId: string | null = null;

function loadServiceAccount(): { client_email: string; private_key: string } {
  if (cachedSaCredentials) return cachedSaCredentials;

  const raw = process.env.MAILPILOT_SA_KEY_JSON;
  if (!raw) {
    throw new Error("MAILPILOT_SA_KEY_JSON env var not set — MailPilot disabled");
  }

  let jsonText = raw.trim();
  // Support both raw JSON and base64-encoded JSON
  if (!jsonText.startsWith("{")) {
    try {
      jsonText = Buffer.from(jsonText, "base64").toString("utf8");
    } catch {
      throw new Error("MAILPILOT_SA_KEY_JSON must be raw JSON or base64 JSON");
    }
  }

  const parsed = JSON.parse(jsonText);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("MAILPILOT_SA_KEY_JSON missing client_email or private_key");
  }

  cachedSaCredentials = {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
  cachedSaClientId = parsed.client_id || null;
  return cachedSaCredentials;
}

/**
 * Returns the numeric client_id of the MailPilot service account.
 * This is the ID that school admins paste into Google Admin Console for DWD.
 */
export function getServiceAccountClientId(): string | null {
  try {
    loadServiceAccount();
    return cachedSaClientId;
  } catch {
    return null;
  }
}

export function getServiceAccountScope(): string {
  return SCOPES[0] ?? "https://www.googleapis.com/auth/gmail.readonly";
}

export function isMailpilotConfigured(): boolean {
  try {
    loadServiceAccount();
    return Boolean(process.env.MAILPILOT_PUBSUB_TOPIC);
  } catch {
    return false;
  }
}

/**
 * Create a Gmail API client that impersonates the given student mailbox.
 * Requires the service account to have domain-wide delegation authorized
 * in the student's Google Workspace (gmail.readonly scope).
 */
export function getGmailClientForStudent(studentEmail: string): gmail_v1.Gmail {
  const sa = loadServiceAccount();
  const jwt = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: SCOPES,
    subject: studentEmail, // impersonation target
  });
  return google.gmail({ version: "v1", auth: jwt });
}

export interface WatchResult {
  historyId: string;
  expiration: Date;
}

/**
 * Start (or refresh) a Gmail watch on the given student mailbox.
 * Gmail will publish change notifications to our Pub/Sub topic.
 * Watches expire after 7 days — scheduler renews them before expiry.
 */
export async function startWatch(studentEmail: string): Promise<WatchResult> {
  const topic = process.env.MAILPILOT_PUBSUB_TOPIC;
  if (!topic) {
    throw new Error("MAILPILOT_PUBSUB_TOPIC env var not set");
  }

  const gmail = getGmailClientForStudent(studentEmail);
  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName: topic,
      labelIds: ["INBOX", "SENT"],
      labelFilterBehavior: "INCLUDE",
    },
  });

  const historyId = String(response.data.historyId || "");
  const expirationMs = Number(response.data.expiration || 0);
  return {
    historyId,
    expiration: new Date(expirationMs),
  };
}

/**
 * Stop the Gmail watch on the given student mailbox.
 */
export async function stopWatch(studentEmail: string): Promise<void> {
  try {
    const gmail = getGmailClientForStudent(studentEmail);
    await gmail.users.stop({ userId: "me" });
  } catch (err: any) {
    // Ignore 404 — watch may already be expired/stopped
    if (err?.code !== 404) throw err;
  }
}

export interface FetchedMessage {
  messageId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: Date | null;
  body: string;
  snippet: string;
  labelIds: string[];
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  if (!payload) return "";

  // Prefer text/plain
  const findPart = (
    parts: gmail_v1.Schema$MessagePart[] | undefined,
    mime: string
  ): gmail_v1.Schema$MessagePart | null => {
    if (!parts) return null;
    for (const p of parts) {
      if (p.mimeType === mime && p.body?.data) return p;
      if (p.parts) {
        const nested = findPart(p.parts, mime);
        if (nested) return nested;
      }
    }
    return null;
  };

  // Direct body
  if (payload.body?.data) {
    try {
      return decodeBase64Url(payload.body.data);
    } catch {
      /* fall through */
    }
  }

  const plainPart = findPart(payload.parts, "text/plain");
  if (plainPart?.body?.data) {
    try {
      return decodeBase64Url(plainPart.body.data);
    } catch {
      /* fall through */
    }
  }

  const htmlPart = findPart(payload.parts, "text/html");
  if (htmlPart?.body?.data) {
    try {
      const html = decodeBase64Url(htmlPart.body.data);
      // Very simple HTML-to-text (strip tags) — classifier doesn't need pretty output
      return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                 .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                 .replace(/<[^>]+>/g, " ")
                 .replace(/&nbsp;/g, " ")
                 .replace(/&amp;/g, "&")
                 .replace(/&lt;/g, "<")
                 .replace(/&gt;/g, ">")
                 .replace(/\s+/g, " ")
                 .trim();
    } catch {
      /* fall through */
    }
  }

  return "";
}

function parseAddresses(raw: string): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => {
    const match = s.match(/<([^>]+)>/);
    return (match ? match[1]! : s).trim();
  }).filter(Boolean);
}

/**
 * Fetch a single Gmail message and extract the fields we need for classification.
 */
export async function fetchMessage(
  studentEmail: string,
  messageId: string
): Promise<FetchedMessage | null> {
  const gmail = getGmailClientForStudent(studentEmail);

  let response;
  try {
    response = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
  } catch (err: any) {
    if (err?.code === 404) return null; // message deleted
    throw err;
  }

  const msg = response.data;
  if (!msg.id) return null;

  const headers = msg.payload?.headers || [];
  const getHeader = (name: string): string => {
    const h = headers.find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
    return h?.value || "";
  };

  const subject = getHeader("Subject");
  const from = getHeader("From");
  const to = parseAddresses(getHeader("To"));
  const cc = parseAddresses(getHeader("Cc"));
  const dateStr = getHeader("Date");
  let date: Date | null = null;
  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) date = parsed;
  }

  return {
    messageId: msg.id,
    threadId: msg.threadId || "",
    subject,
    from,
    to,
    cc,
    date,
    body: extractBody(msg.payload),
    snippet: msg.snippet || "",
    labelIds: msg.labelIds || [],
  };
}

/**
 * Fetch message IDs added since the given historyId.
 * Returns the new messageIds plus the updated historyId cursor.
 */
export async function listHistorySince(
  studentEmail: string,
  startHistoryId: string
): Promise<{ messageIds: string[]; newHistoryId: string }> {
  const gmail = getGmailClientForStudent(studentEmail);
  const messageIds = new Set<string>();
  let newHistoryId = startHistoryId;
  let pageToken: string | undefined;

  // Single pass with no labelId filter — captures both INBOX and SENT
  // (the watch is already registered for those two labels only, so Gmail
  // will not publish history for other labels). Previous version ran a
  // redundant second pass; removed to halve Gmail quota usage per notification.
  do {
    const params: gmail_v1.Params$Resource$Users$History$List = {
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
    };
    if (pageToken) params.pageToken = pageToken;

    let response;
    try {
      response = await gmail.users.history.list(params);
    } catch (err: any) {
      // 404 means historyId is too old — caller must re-bootstrap from users.watch
      if (err?.code === 404) throw new Error("history_expired");
      throw err;
    }

    for (const h of response.data.history || []) {
      for (const added of h.messagesAdded || []) {
        if (added.message?.id) messageIds.add(added.message.id);
      }
    }
    if (response.data.historyId) newHistoryId = String(response.data.historyId);
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);

  return { messageIds: Array.from(messageIds), newHistoryId };
}

export function determineDirection(
  studentEmail: string,
  labelIds: string[],
  from: string
): "inbound" | "outbound" {
  const normalizedStudent = studentEmail.toLowerCase().trim();
  const fromLower = from.toLowerCase();
  if (labelIds.includes("SENT")) return "outbound";
  if (fromLower.includes(normalizedStudent)) return "outbound";
  return "inbound";
}
