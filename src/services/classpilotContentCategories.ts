/** Reviewed browser-content labels. These labels never grant blocking authority. */
export const CONTENT_CATEGORY_RULESET_VERSION = "content-categories-2026-09-05.2";
export const CONTENT_CATEGORIES = [
  "Gaming", "Social media", "Video", "Music", "Messaging", "Forums", "Shopping", "Sports", "News", "Entertainment",
  "AI tools", "Finance", "Travel", "Lifestyle", "Technology", "Health", "Education", "Reference", "Productivity", "Gambling",
] as const;
export type ContentCategory = typeof CONTENT_CATEGORIES[number];
export function normalizeContentCategory(value: unknown): ContentCategory | null {
  return typeof value === "string" && (CONTENT_CATEGORIES as readonly string[]).includes(value) ? value as ContentCategory : null;
}
const REVIEWED_DOMAINS: ReadonlyArray<readonly [ContentCategory, readonly string[]]> = [
  ["Gaming", ["roblox.com", "minecraft.net", "fortnite.com", "epicgames.com", "steampowered.com", "poki.com", "crazygames.com"]],
  ["Social media", ["instagram.com", "snapchat.com", "twitter.com", "x.com", "facebook.com", "tiktok.com"]],
  ["Video", ["youtube.com", "youtu.be", "twitch.tv", "netflix.com", "hulu.com", "disneyplus.com", "vimeo.com"]],
  ["Music", ["spotify.com", "music.apple.com", "soundcloud.com", "pandora.com"]],
  ["Messaging", ["discord.com", "whatsapp.com", "messenger.com", "telegram.org"]],
  ["Forums", ["reddit.com", "quora.com"]],
  ["Shopping", ["ebay.com", "etsy.com", "walmart.com", "target.com"]],
  ["Sports", ["espn.com", "nba.com", "nfl.com", "mlb.com", "nhl.com"]],
  ["News", ["apnews.com", "reuters.com", "bbc.com", "nytimes.com", "npr.org"]],
  ["Entertainment", ["imdb.com", "rottentomatoes.com", "fandom.com"]],
  ["AI tools", ["chatgpt.com", "gemini.google.com", "bard.google.com", "claude.ai", "perplexity.ai", "character.ai", "poe.com", "copilot.microsoft.com", "quillbot.com", "deepseek.com"]],
  ["Finance", ["finance.yahoo.com", "investopedia.com", "tradingview.com"]],
  ["Travel", ["tripadvisor.com", "expedia.com", "booking.com", "airbnb.com"]],
  ["Lifestyle", ["allrecipes.com", "foodnetwork.com", "goodhousekeeping.com"]],
  ["Technology", ["arstechnica.com", "theverge.com", "techcrunch.com"]],
  ["Health", ["medlineplus.gov", "mayoclinic.org", "nih.gov", "cdc.gov", "kidshealth.org"]],
  ["Education", ["khanacademy.org", "edpuzzle.com", "quizlet.com", "kahoot.it", "brainpop.com", "ixl.com", "desmos.com", "code.org", "classroom.google.com", "schoology.com", "instructure.com", "clever.com", "classlink.com", "nearpod.com", "zearn.org", "nwea.org", "mapnwea.org"]],
  ["Reference", ["wikipedia.org", "britannica.com", "dictionary.com", "merriam-webster.com"]],
  ["Productivity", ["docs.google.com", "drive.google.com", "slides.google.com", "sheets.google.com", "forms.google.com", "office.com", "notion.so", "trello.com"]],
  ["Gambling", ["draftkings.com", "fanduel.com", "bet365.com", "betmgm.com", "bovada.lv", "stake.com"]],
];
export function reviewedContentCategoryForDomain(domain: string): ContentCategory | null {
  const hostname = domain.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  let winner: { category: ContentCategory; length: number } | undefined;
  for (const [category, domains] of REVIEWED_DOMAINS) for (const candidate of domains) {
    if ((hostname === candidate || hostname.endsWith(`.${candidate}`)) && candidate.length > (winner?.length ?? 0)) {
      winner = { category, length: candidate.length };
    }
  }
  return winner?.category ?? null;
}

/** Largest-remainder allocation preserves the exact integer off-task total. */
export function allocateOffTaskCategorySeconds(
  entries: ReadonlyArray<{ contentCategory: unknown; milliseconds: number }>, totalSeconds: number,
): Array<{ contentCategory: ContentCategory | null; seconds: number }> {
  const totals = new Map<ContentCategory | null, number>();
  for (const entry of entries) if (entry.milliseconds > 0) {
    const category = normalizeContentCategory(entry.contentCategory);
    totals.set(category, (totals.get(category) ?? 0) + entry.milliseconds);
  }
  const milliseconds = [...totals.values()].reduce((sum, value) => sum + value, 0);
  if (!milliseconds || totalSeconds <= 0) return [];
  const rows = [...totals].map(([contentCategory, value]) => {
    const exact = value / milliseconds * totalSeconds;
    return { contentCategory, seconds: Math.floor(exact), remainder: exact % 1 };
  }).sort((a, b) => b.remainder - a.remainder || String(a.contentCategory).localeCompare(String(b.contentCategory)));
  let remaining = totalSeconds - rows.reduce((sum, row) => sum + row.seconds, 0);
  for (const row of rows) if (remaining-- > 0) row.seconds++;
  return rows.filter((row) => row.seconds > 0).sort((a, b) => b.seconds - a.seconds)
    .map(({ contentCategory, seconds }) => ({ contentCategory, seconds }));
}
