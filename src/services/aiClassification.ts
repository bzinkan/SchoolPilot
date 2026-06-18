import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let anthropic: Anthropic | null = null;
if (ANTHROPIC_API_KEY) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
}

export interface AiClassification {
  category: "educational" | "non-educational" | "unknown";
  safetyAlert: "self-harm" | "violence" | "sexual" | "drugs" | null;
  domain: string;
  classifiedAt: number;
}

export interface AiClassificationOptions {
  schoolDomain?: string | null;
  useAiFallback?: boolean;
}

// Simple domain cache to avoid re-classifying the same URLs
const classificationCache = new Map<string, AiClassification>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 5000;

function extractDomain(url: string): string {
  try {
    return normalizeDomainValue(new URL(url).hostname) || url;
  } catch {
    return normalizeDomainValue(url) || url;
  }
}

// Known educational domains — skip AI classification for these
const KNOWN_EDUCATIONAL = new Set([
  "google.com", "docs.google.com", "drive.google.com", "classroom.google.com",
  "slides.google.com", "sheets.google.com", "forms.google.com",
  "sites.google.com", "meet.google.com",
  "khanacademy.org", "edpuzzle.com", "quizlet.com", "kahoot.it",
  "brainpop.com", "newsela.com", "readworks.org", "ixl.com",
  "prodigygame.com", "desmos.com", "geogebra.org", "scratch.mit.edu",
  "code.org", "typing.com", "schoology.com", "canvas.instructure.com",
  "instructure.com", "blackboard.com", "moodle.org",
  "clever.com", "classlink.com", "launchpad.classlink.com", "my.classlink.com",
  "classlink.io", "seesaw.me", "nearpod.com", "flipgrid.com",
  "peardeck.com", "wikipedia.org", "britannica.com",
  "iready.com", "i-ready.com", "savvasrealize.com", "savvas.com",
  "hmhco.com", "hmhcentral.com", "read180.com", "commonlit.org",
  "noredink.com", "edulastic.com", "pearsonrealize.com", "achieve3000.com",
  "mobymax.com", "zearn.org", "amplify.com", "ck12.org",
]);

const KNOWN_NON_EDUCATIONAL = new Set([
  "youtube.com", "tiktok.com", "instagram.com", "snapchat.com",
  "twitter.com", "x.com", "facebook.com", "reddit.com",
  "twitch.tv", "discord.com", "roblox.com", "minecraft.net",
  "fortnite.com", "epicgames.com", "steampowered.com",
  "netflix.com", "hulu.com", "disneyplus.com", "spotify.com",
  "espn.com", "yahoo.com",
]);

// Known unsafe domains — instant safety alert + auto-block
const KNOWN_UNSAFE: Map<string, "sexual" | "violence" | "drugs" | "self-harm"> = new Map([
  ["pornhub.com", "sexual"], ["xvideos.com", "sexual"], ["xnxx.com", "sexual"],
  ["xhamster.com", "sexual"], ["redtube.com", "sexual"], ["youporn.com", "sexual"],
  ["tube8.com", "sexual"], ["spankbang.com", "sexual"], ["chaturbate.com", "sexual"],
  ["onlyfans.com", "sexual"], ["brazzers.com", "sexual"], ["livejasmin.com", "sexual"],
  ["cam4.com", "sexual"], ["bongacams.com", "sexual"], ["stripchat.com", "sexual"],
  ["rule34.xxx", "sexual"], ["nhentai.net", "sexual"], ["hanime.tv", "sexual"],
  ["hentaihaven.xxx", "sexual"], ["tik.porn", "sexual"],
  ["bestgore.com", "violence"], ["liveleak.com", "violence"],
  ["silkroad.com", "drugs"], ["darkweb.com", "drugs"],
]);

export function isAiAvailable(): boolean {
  return anthropic !== null;
}

function normalizeDomainValue(value?: string | null): string | null {
  const cleaned = String(value || "").trim().toLowerCase();
  if (!cleaned) return null;

  try {
    const withProtocol = cleaned.includes("://") ? cleaned : `https://${cleaned}`;
    return new URL(withProtocol).hostname.replace(/^www\./, "");
  } catch {
    return cleaned
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.split(":")[0]
      ?.replace(/^www\./, "") || null;
  }
}

function domainMatches(domain: string, candidate?: string | null): boolean {
  const normalized = normalizeDomainValue(candidate);
  if (!normalized) return false;
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

function matchesAnyDomain(domain: string, candidates: Iterable<string>): boolean {
  for (const candidate of candidates) {
    if (domainMatches(domain, candidate)) return true;
  }
  return false;
}

function getUnsafeDomainType(domain: string): "sexual" | "violence" | "drugs" | "self-harm" | null {
  for (const [unsafeDomain, unsafeType] of KNOWN_UNSAFE.entries()) {
    if (domainMatches(domain, unsafeDomain)) return unsafeType;
  }
  return null;
}

function cacheClassification(cacheKey: string, result: AiClassification): AiClassification {
  if (classificationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = classificationCache.keys().next().value;
    if (firstKey) classificationCache.delete(firstKey);
  }
  classificationCache.set(cacheKey, result);
  return result;
}

function classifyUnsafeSearch(url: string, domain: string): AiClassification | null {
  if (domain !== "google.com" && domain !== "bing.com" && domain !== "search.yahoo.com") {
    return null;
  }

  try {
    const searchUrl = new URL(url);
    const query = (searchUrl.searchParams.get("q") || searchUrl.searchParams.get("p") || "").toLowerCase();
    const unsafeSearchTerms = [
      "porn", "xxx", "hentai", "nude", "naked", "sex video", "onlyfans",
      "how to kill", "how to make a bomb", "buy drugs", "buy weed",
      "self harm", "suicide method",
    ];
    const matchedTerm = unsafeSearchTerms.find(term => query.includes(term));
    if (!matchedTerm) return null;

    const alertType: "sexual" | "violence" | "drugs" | "self-harm" =
      ["porn", "xxx", "hentai", "nude", "naked", "sex video", "onlyfans"].includes(matchedTerm) ? "sexual" :
      ["how to kill", "how to make a bomb"].includes(matchedTerm) ? "violence" :
      ["buy drugs", "buy weed"].includes(matchedTerm) ? "drugs" : "self-harm";

    return {
      category: "non-educational",
      safetyAlert: alertType,
      domain: `search:${matchedTerm}`,
      classifiedAt: Date.now(),
    };
  } catch {
    return null;
  }
}

export async function classifyUrl(
  url: string,
  title?: string,
  options: AiClassificationOptions = {}
): Promise<AiClassification | null> {
  const domain = extractDomain(url);
  const schoolDomain = normalizeDomainValue(options.schoolDomain);

  // Unsafe searches are query-specific and must run before the domain cache,
  // otherwise cached google.com = educational could hide a later risky search.
  const unsafeSearch = classifyUnsafeSearch(url, domain);
  if (unsafeSearch) return unsafeSearch;

  const cacheKey = `${domain}|school:${schoolDomain || ""}|ai:${options.useAiFallback === false ? "off" : "on"}`;
  const cached = classificationCache.get(cacheKey);
  if (cached && Date.now() - cached.classifiedAt < CACHE_TTL_MS) {
    return cached;
  }

  if (schoolDomain && domainMatches(domain, schoolDomain)) {
    return cacheClassification(cacheKey, {
      category: "educational",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    });
  }

  // Known domains — instant classification
  if (matchesAnyDomain(domain, KNOWN_EDUCATIONAL)) {
    const result: AiClassification = {
      category: "educational",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    };
    return cacheClassification(cacheKey, result);
  }
  if (matchesAnyDomain(domain, KNOWN_NON_EDUCATIONAL)) {
    const result: AiClassification = {
      category: "non-educational",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    };
    return cacheClassification(cacheKey, result);
  }

  // Known unsafe domains — instant safety alert
  const unsafeType = getUnsafeDomainType(domain);
  if (unsafeType) {
    const result: AiClassification = {
      category: "non-educational",
      safetyAlert: unsafeType,
      domain,
      classifiedAt: Date.now(),
    };
    return cacheClassification(cacheKey, result);
  }

  // Skip chrome-internal URLs
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    return null;
  }

  if (!anthropic || options.useAiFallback === false) {
    return cacheClassification(cacheKey, {
      category: "unknown",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    });
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `You are a K-12 school web content classifier. Given a URL and page title from a student's Chromebook, classify the content. Respond ONLY with valid JSON, no other text:
{"category":"educational"|"non-educational"|"unknown","safetyAlert":"self-harm"|"violence"|"sexual"|"drugs"|null}

Rules:
- "educational": academic content, research, school tools, learning platforms
- "non-educational": ONLY clearly distracting social media, gaming, streaming video, shopping, sports, chat, music, or entertainment
- "unknown": can't determine, mixed-purpose, school/local organization pages, utilities, logins, curriculum vendors you do not recognize, or any ambiguous site
- When unsure, choose "unknown" rather than "non-educational"
- safetyAlert: ONLY flag genuinely concerning content (self-harm ideation, graphic violence, explicit sexual content, drug use/purchase). Do NOT flag normal news or health education.

URL: ${url}
Title: ${title || "Unknown"}`,
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (!text) return null;

    const parsed = JSON.parse(text);
    const category = parsed.category === "educational" || parsed.category === "non-educational"
      ? parsed.category
      : "unknown";
    const safetyAlert = ["self-harm", "violence", "sexual", "drugs"].includes(parsed.safetyAlert)
      ? parsed.safetyAlert
      : null;
    const result: AiClassification = {
      category,
      safetyAlert,
      domain,
      classifiedAt: Date.now(),
    };

    return cacheClassification(cacheKey, result);
  } catch (error) {
    console.error("[AI Classification] Error:", error);
    return null;
  }
}

// ============================================================================
// classifyEmail — Gmail safety classification (MailPilot)
// ============================================================================
export type EmailSafetyCategory = "self-harm" | "violence" | "sexual" | "drugs" | "bullying";

export interface EmailClassification {
  category: "educational" | "non-educational" | "unknown";
  safetyAlert: EmailSafetyCategory | null;
  bullying: boolean;
  confidence: number; // 0-100
  severity: "low" | "medium" | "high" | "critical";
  reasoning: string;
  classifiedAt: number;
}

const MAX_EMAIL_BODY_CHARS = 4000;

/**
 * Classify an email message for safety concerns in a K-12 school context.
 * Covers self-harm, violence, sexual content, drug use, and bullying/harassment.
 * Unlike classifyUrl, emails are NOT cached (each message is unique).
 */
export async function classifyEmail(input: {
  subject?: string;
  from: string;
  to: string[];
  body: string;
  direction: "inbound" | "outbound";
}): Promise<EmailClassification | null> {
  if (!anthropic) return null;

  const { subject = "", from, to, body, direction } = input;
  const truncatedBody = body.length > MAX_EMAIL_BODY_CHARS
    ? body.slice(0, MAX_EMAIL_BODY_CHARS) + "\n...[truncated]"
    : body;

  const prompt = `You are a K-12 student safety classifier reviewing a student's Gmail message. Classify for the following safety concerns:
- self-harm: suicide ideation, self-injury, hopelessness
- violence: threats of violence toward self or others, weapons, graphic violence
- sexual: explicit sexual content, solicitation, grooming, sexting
- drugs: drug use, sale, or acquisition (alcohol, cannabis, harder drugs)
- bullying: harassment, cyberbullying, targeted insults, exclusion campaigns

Respond ONLY with valid JSON, no other text:
{
  "category": "educational" | "non-educational" | "unknown",
  "safetyAlert": "self-harm" | "violence" | "sexual" | "drugs" | "bullying" | null,
  "bullying": boolean,
  "confidence": 0-100,
  "severity": "low" | "medium" | "high" | "critical",
  "reasoning": "one short sentence on why (or why not) this was flagged"
}

Rules:
- Do NOT flag normal peer conversation, academic content, or legitimate news/health topics.
- "confidence" reflects how sure you are of the safetyAlert classification (high for clear cases, low if ambiguous).
- "severity" reflects urgency: critical = imminent risk (explicit suicide plan, active violence threat); high = serious concern; medium = warrants review; low = borderline.
- If safetyAlert is null, severity should be "low".
- For outbound student-authored messages, weight threats/self-harm language more heavily (the student is expressing the content).
- For inbound messages, flag predatory/grooming contact and adult-to-minor inappropriate content.

Direction: ${direction}
From: ${from}
To: ${to.join(", ")}
Subject: ${subject}
Body:
${truncatedBody}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (!text) return null;

    // Strip possible code-fence wrappers
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const parsed = JSON.parse(cleaned);

    return {
      category: parsed.category === "educational" || parsed.category === "non-educational" ? parsed.category : "unknown",
      safetyAlert: parsed.safetyAlert && ["self-harm", "violence", "sexual", "drugs", "bullying"].includes(parsed.safetyAlert)
        ? parsed.safetyAlert
        : null,
      bullying: Boolean(parsed.bullying),
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
      severity: ["low", "medium", "high", "critical"].includes(parsed.severity) ? parsed.severity : "low",
      reasoning: String(parsed.reasoning || "").slice(0, 500),
      classifiedAt: Date.now(),
    };
  } catch (error) {
    console.error("[AI Classification] classifyEmail error:", error);
    return null;
  }
}
