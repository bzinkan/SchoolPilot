// Polls Instantly.ai API for new email replies and sends notifications to Telegram
// Run with: node scripts/instantly-reply-monitor.js

const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!INSTANTLY_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error("Missing required env vars: INSTANTLY_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID");
  process.exit(1);
}
const POLL_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";
const headers = {
  Authorization: `Bearer ${INSTANTLY_API_KEY}`,
  "Content-Type": "application/json",
};

// Track seen reply IDs to avoid duplicate notifications
const seenReplies = new Set();
let initialized = false;

async function fetchAllCampaigns() {
  const campaigns = [];
  let startingAfter = null;

  while (true) {
    const url = new URL(`${INSTANTLY_BASE}/campaigns`);
    url.searchParams.set("limit", "50");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await fetch(url.toString(), { headers });
    const data = await res.json();

    if (!data.items || data.items.length === 0) break;
    campaigns.push(...data.items);

    if (!data.next_starting_after) break;
    startingAfter = data.next_starting_after;
  }

  return campaigns;
}

async function fetchReplies(campaignId) {
  try {
    const url = new URL(`${INSTANTLY_BASE}/emails`);
    url.searchParams.set("campaign_id", campaignId);
    url.searchParams.set("email_type", "reply");
    url.searchParams.set("limit", "20");

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      // Try alternative endpoint
      return [];
    }
    const data = await res.json();
    return data.items || data || [];
  } catch (err) {
    console.error(`[Instantly] Error fetching replies for campaign ${campaignId}:`, err.message);
    return [];
  }
}

async function fetchLeadsWithReplies(campaignId) {
  try {
    const url = new URL(`${INSTANTLY_BASE}/leads`);
    url.searchParams.set("campaign_id", campaignId);
    url.searchParams.set("has_replied", "true");
    url.searchParams.set("limit", "50");

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch (err) {
    console.error(`[Instantly] Error fetching leads for campaign ${campaignId}:`, err.message);
    return [];
  }
}

async function sendTelegramNotification(message) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("[Telegram] Failed to send notification:", err.message);
  }
}

async function checkForNewReplies() {
  const campaigns = await fetchAllCampaigns();
  console.log(`[${new Date().toLocaleTimeString()}] Checking ${campaigns.length} campaigns for replies...`);

  let newReplyCount = 0;

  for (const campaign of campaigns) {
    const leads = await fetchLeadsWithReplies(campaign.id);

    for (const lead of leads) {
      const replyKey = `${campaign.id}:${lead.email}:${lead.timestamp_replied || lead.timestamp_updated}`;

      if (seenReplies.has(replyKey)) continue;
      seenReplies.add(replyKey);

      // Skip on first run (mark all existing as seen)
      if (!initialized) continue;

      newReplyCount++;

      const sendingAccount = campaign.email_list?.[0] || "unknown";
      const message = [
        `📧 *New Reply on Instantly*`,
        ``,
        `*From:* ${lead.email}`,
        `*Name:* ${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
        `*Company:* ${lead.company_name || "N/A"}`,
        `*Campaign:* ${campaign.name}`,
        `*Sending Account:* ${sendingAccount}`,
        `*Time:* ${lead.timestamp_replied || lead.timestamp_updated || "unknown"}`,
      ].join("\n");

      console.log(`  NEW REPLY: ${lead.email} → campaign "${campaign.name}" (via ${sendingAccount})`);
      await sendTelegramNotification(message);

      // Rate limit: don't spam Telegram
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  if (!initialized) {
    initialized = true;
    console.log(`  Initialized with ${seenReplies.size} existing replies. Now watching for new ones.`);
  } else if (newReplyCount === 0) {
    console.log(`  No new replies.`);
  } else {
    console.log(`  ${newReplyCount} new reply(ies) notified.`);
  }
}

// Main loop
async function main() {
  console.log("=== Instantly Reply Monitor ===");
  console.log(`Polling every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Telegram bot: ${TELEGRAM_BOT_TOKEN.slice(0, 10)}...`);
  console.log("");

  // Initial check (marks existing replies as seen)
  await checkForNewReplies();

  // Poll on interval
  setInterval(checkForNewReplies, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
