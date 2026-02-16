import OpenAI from "openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

let openai: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
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
]);

export function isAiAvailable(): boolean {
  return openai !== null;
}

export async function classifyUrl(
  url: string,
  title?: string
): Promise<AiClassification | null> {
  if (!openai) return null;

  const domain = extractDomain(url);

  // Check cache first
  const cached = classificationCache.get(domain);
  if (cached && Date.now() - cached.classifiedAt < CACHE_TTL_MS) {
    return cached;
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

  // Skip chrome-internal URLs
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:")) {
    return null;
  }

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 150,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: `You are a K-12 school web content classifier. Given a URL and page title from a student's Chromebook, classify the content. Respond ONLY with valid JSON:
{"category":"educational"|"non-educational"|"unknown","safetyAlert":"self-harm"|"violence"|"sexual"|"drugs"|null}

Rules:
- "educational": academic content, research, school tools, learning platforms
- "non-educational": social media, gaming, entertainment, shopping
- "unknown": can't determine
- safetyAlert: ONLY flag genuinely concerning content (self-harm ideation, graphic violence, explicit sexual content, drug use/purchase). Do NOT flag normal news or health education.`,
        },
        {
          role: "user",
          content: `URL: ${url}\nTitle: ${title || "Unknown"}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content?.trim();
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
