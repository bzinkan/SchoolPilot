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

// Simple domain cache to avoid re-classifying the same URLs
const classificationCache = new Map<string, AiClassification>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_SIZE = 5000;

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Known educational domains — skip AI classification for these
const KNOWN_EDUCATIONAL = new Set([
  "google.com", "docs.google.com", "drive.google.com", "classroom.google.com",
  "slides.google.com", "sheets.google.com", "forms.google.com",
  "khanacademy.org", "edpuzzle.com", "quizlet.com", "kahoot.it",
  "brainpop.com", "newsela.com", "readworks.org", "ixl.com",
  "prodigygame.com", "desmos.com", "geogebra.org", "scratch.mit.edu",
  "code.org", "typing.com", "schoology.com", "canvas.instructure.com",
  "clever.com", "seesaw.me", "nearpod.com", "flipgrid.com",
  "pear.deck", "wikipedia.org", "britannica.com",
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

export async function classifyUrl(
  url: string,
  title?: string
): Promise<AiClassification | null> {
  if (!anthropic) return null;

  const domain = extractDomain(url);

  // Check cache first
  const cached = classificationCache.get(domain);
  if (cached && Date.now() - cached.classifiedAt < CACHE_TTL_MS) {
    return cached;
  }

  // Check Google/Bing searches for unsafe queries before marking as educational
  if (domain === "google.com" || domain === "bing.com" || domain === "search.yahoo.com") {
    try {
      const searchUrl = new URL(url);
      const query = (searchUrl.searchParams.get("q") || searchUrl.searchParams.get("p") || "").toLowerCase();
      const unsafeSearchTerms = [
        "porn", "xxx", "hentai", "nude", "naked", "sex video", "onlyfans",
        "how to kill", "how to make a bomb", "buy drugs", "buy weed",
        "self harm", "suicide method",
      ];
      const matchedTerm = unsafeSearchTerms.find(term => query.includes(term));
      if (matchedTerm) {
        const alertType: "sexual" | "violence" | "drugs" | "self-harm" =
          ["porn", "xxx", "hentai", "nude", "naked", "sex video", "onlyfans"].includes(matchedTerm) ? "sexual" :
          ["how to kill", "how to make a bomb"].includes(matchedTerm) ? "violence" :
          ["buy drugs", "buy weed"].includes(matchedTerm) ? "drugs" : "self-harm";
        const result: AiClassification = {
          category: "non-educational",
          safetyAlert: alertType,
          domain: `search:${matchedTerm}`,
          classifiedAt: Date.now(),
        };
        return result; // Don't cache — each search is unique
      }
    } catch { /* fall through */ }
  }

  // Known domains — instant classification
  if (KNOWN_EDUCATIONAL.has(domain)) {
    const result: AiClassification = {
      category: "educational",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    };
    classificationCache.set(domain, result);
    return result;
  }
  if (KNOWN_NON_EDUCATIONAL.has(domain)) {
    const result: AiClassification = {
      category: "non-educational",
      safetyAlert: null,
      domain,
      classifiedAt: Date.now(),
    };
    classificationCache.set(domain, result);
    return result;
  }

  // Known unsafe domains — instant safety alert
  const unsafeType = KNOWN_UNSAFE.get(domain);
  if (unsafeType) {
    const result: AiClassification = {
      category: "non-educational",
      safetyAlert: unsafeType,
      domain,
      classifiedAt: Date.now(),
    };
    classificationCache.set(domain, result);
    return result;
  }

  // Skip chrome-internal URLs
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    return null;
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
- "non-educational": social media, gaming, entertainment, shopping, sports, news
- "unknown": can't determine
- safetyAlert: ONLY flag genuinely concerning content (self-harm ideation, graphic violence, explicit sexual content, drug use/purchase). Do NOT flag normal news or health education.

URL: ${url}
Title: ${title || "Unknown"}`,
        },
      ],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (!text) return null;

    const parsed = JSON.parse(text);
    const result: AiClassification = {
      category: parsed.category || "unknown",
      safetyAlert: parsed.safetyAlert || null,
      domain,
      classifiedAt: Date.now(),
    };

    // Manage cache size
    if (classificationCache.size >= MAX_CACHE_SIZE) {
      const firstKey = classificationCache.keys().next().value;
      if (firstKey) classificationCache.delete(firstKey);
    }
    classificationCache.set(domain, result);

    return result;
  } catch (error) {
    console.error("[AI Classification] Error:", error);
    return null;
  }
}
