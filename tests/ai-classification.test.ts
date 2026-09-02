import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Imports the COMPILED output (CI builds first) so we exercise exactly what ships.
import { classifyUrl, matchUnsafeSearchQuery } from "../dist/services/aiClassification.js";

const noAi = { useAiFallback: false as const };

describe("ClassPilot conservative URL classification", () => {
  it("treats known learning portals and ClassLink-style subdomains as educational", async () => {
    assert.equal((await classifyUrl("https://launchpad.classlink.com/home", "LaunchPad"))?.category, "educational");
    assert.equal((await classifyUrl("https://classroom.google.com/c/123", "Google Classroom"))?.category, "educational");
    assert.equal((await classifyUrl("https://student.desmos.com/activity", "Desmos"))?.category, "educational");
  });

  it("treats the configured school domain and subdomains as educational", async () => {
    const result = await classifyUrl(
      "https://library.desalescincy.org/resources",
      "School library",
      { schoolDomain: "desalescincy.org" }
    );

    assert.equal(result?.category, "educational");
    assert.equal(result?.safetyAlert, null);
    assert.equal(result?.source, "school-domain");
    assert.equal(result?.matchedTerm, "desalescincy.org");
  });

  it("flags obvious distraction domains locally", async () => {
    const result = await classifyUrl("https://www.youtube.com/watch?v=abc", "YouTube");

    assert.equal(result?.category, "non-educational");
    assert.equal(result?.safetyAlert, null);
    assert.equal(result?.source, "known-list");
    assert.equal(result?.matchedTerm, "youtube.com");
  });

  it("leaves ambiguous unknown domains neutral when AI fallback is disabled", async () => {
    const result = await classifyUrl(
      "https://example-community-center.org/homework-help",
      "Homework help",
      noAi
    );

    assert.equal(result?.category, "unknown");
    assert.equal(result?.safetyAlert, null);
    assert.equal(result?.source, "unknown");
    assert.equal(result?.matchedTerm, null);
  });

  it("checks unsafe search queries before returning a cached safe search domain", async () => {
    assert.equal((await classifyUrl("https://google.com/search?q=algebra", "Google"))?.category, "educational");

    const result = await classifyUrl("https://google.com/search?q=suicide%20method", "Google Search");

    assert.equal(result?.category, "non-educational");
    assert.equal(result?.safetyAlert, "self-harm");

    // The search hit is never written to the domain cache.
    const again = await classifyUrl("https://google.com/search?q=algebra", "Google");
    assert.equal(again?.category, "educational");
    assert.equal(again?.safetyAlert, null);
  });

  it("reports an exact list entry rather than a parent domain", async () => {
    const result = await classifyUrl("https://docs.google.com/document/d/1", "Docs");
    assert.equal(result?.category, "educational");
    assert.equal(result?.matchedTerm, "docs.google.com");
  });
});

describe("ClassPilot unsafe search detection", () => {
  it("flags help-seeking and explicit self-harm searches on Google", async () => {
    const commit = await classifyUrl("https://www.google.com/search?q=how+to+commit+suicide", "Google Search");
    assert.equal(commit?.safetyAlert, "self-harm");
    assert.equal(commit?.category, "non-educational");
    assert.equal(commit?.source, "search");
    assert.equal(commit?.matchedTerm, "commit suicide");
    assert.equal(commit?.domain, "search:commit suicide");

    const hotline = await classifyUrl("https://google.com/search?q=suicide%20prevention%20hotline", "Google");
    assert.equal(hotline?.safetyAlert, "self-harm");
    assert.equal(hotline?.matchedTerm, "suicide");
  });

  it("labels self-directed harm as self-harm, not violence", async () => {
    const result = await classifyUrl("https://google.com/search?q=how%20to%20kill%20myself", "Google Search");
    assert.equal(result?.safetyAlert, "self-harm");
    assert.equal(result?.matchedTerm, "kill myself");

    const yahoo = await classifyUrl("https://search.yahoo.com/search?p=HOW%20TO%20KILL%20MYSELF", "Yahoo");
    assert.equal(yahoo?.safetyAlert, "self-harm");
    assert.equal(yahoo?.matchedTerm, "kill myself");
  });

  it("does not flag the classic false positives", async () => {
    for (const query of [
      "to%20kill%20a%20mockingbird%20summary",
      "naked%20eye%20astronomy",
      "nude%20color%20palette",
      "xxxtentacion",
      "how%20to%20make%20a%20bath%20bomb",
      "how%20to%20get%20high%20school%20diploma",
    ]) {
      const result = await classifyUrl(`https://google.com/search?q=${query}`, "Google");
      assert.equal(result?.safetyAlert, null, query);
      assert.equal(result?.category, "educational", query);
    }
  });

  it("inspects YouTube, DuckDuckGo, Bing and ccTLD Google searches", async () => {
    const youtube = await classifyUrl("https://www.youtube.com/results?search_query=porn", "YouTube");
    assert.equal(youtube?.safetyAlert, "sexual");
    assert.equal(youtube?.matchedTerm, "porn");

    const cleanYoutube = await classifyUrl("https://m.youtube.com/results?search_query=algebra", "YouTube");
    assert.equal(cleanYoutube?.safetyAlert, null);
    assert.equal(cleanYoutube?.category, "non-educational");

    const ddg = await classifyUrl("https://duckduckgo.com/?q=buy+weed", "DuckDuckGo");
    assert.equal(ddg?.safetyAlert, "drugs");
    assert.equal(ddg?.matchedTerm, "buy drugs");

    const ddgKiller = await classifyUrl("https://duckduckgo.com/?q=buy+weed+killer", "DuckDuckGo", noAi);
    assert.equal(ddgKiller?.safetyAlert, null);
    assert.equal(ddgKiller?.category, "unknown");

    const hashRouted = await classifyUrl("https://duckduckgo.com/#q=how%20to%20kill%20myself", "DuckDuckGo");
    assert.equal(hashRouted?.safetyAlert, "self-harm");

    const bingPlan = await classifyUrl("https://www.bing.com/search?q=school+shooting+plan", "Bing");
    assert.equal(bingPlan?.safetyAlert, "violence");
    assert.equal(bingPlan?.matchedTerm, "school shooting plan");

    const bingStats = await classifyUrl("https://www.bing.com/search?q=school+shooting+statistics", "Bing", noAi);
    assert.equal(bingStats?.safetyAlert, null);

    const ukBomb = await classifyUrl("https://www.google.co.uk/search?q=how+to+make+a+bomb", "Google");
    assert.equal(ukBomb?.safetyAlert, "violence");
    assert.equal(ukBomb?.matchedTerm, "make a bomb");

    const minecraft = await classifyUrl("https://www.google.co.uk/search?q=how+to+make+a+bomb+in+minecraft", "Google", noAi);
    assert.equal(minecraft?.safetyAlert, null);
  });

  it("normalizes unicode and survives very long queries", async () => {
    const fullwidth = await classifyUrl("https://google.com/search?q=%EF%BD%90%EF%BD%8F%EF%BD%92%EF%BD%8E", "Google");
    assert.equal(fullwidth?.safetyAlert, "sexual");
    assert.equal(fullwidth?.matchedTerm, "porn");

    const inside = await classifyUrl(`https://google.com/search?q=porn${"%20a".repeat(1700)}`, "Google");
    assert.equal(inside?.safetyAlert, "sexual");

    const beyond = await classifyUrl(`https://google.com/search?q=${"a%20".repeat(1700)}porn`, "Google");
    assert.equal(beyond?.safetyAlert, null);
    assert.equal(beyond?.category, "educational");
  });
});

describe("ClassPilot unsafe search lexicon", () => {
  it("matches phrases at word boundaries only", () => {
    assert.equal(matchUnsafeSearchQuery("how to kill a mockingbird"), null);
    assert.equal(matchUnsafeSearchQuery("naked mole rat facts"), null);
    assert.equal(matchUnsafeSearchQuery("how to get a gun license"), null);
    assert.equal(matchUnsafeSearchQuery("weed killer for lawns"), null);
    assert.equal(matchUnsafeSearchQuery(""), null);
    assert.deepEqual(matchUnsafeSearchQuery("self-harm"), { safetyAlert: "self-harm", label: "self harm" });
    assert.deepEqual(matchUnsafeSearchQuery("selfharm"), { safetyAlert: "self-harm", label: "self harm" });
    assert.deepEqual(matchUnsafeSearchQuery("how many tylenol to overdose"), { safetyAlert: "self-harm", label: "overdose amount" });
    assert.deepEqual(matchUnsafeSearchQuery("buy vapes near me"), { safetyAlert: "drugs", label: "buy drugs" });
    assert.deepEqual(matchUnsafeSearchQuery("elf bars near me"), { safetyAlert: "drugs", label: "buy vape" });
    assert.deepEqual(matchUnsafeSearchQuery("rule34.xxx"), { safetyAlert: "sexual", label: "xxx" });
    assert.deepEqual(matchUnsafeSearchQuery("rule 34 comics"), { safetyAlert: "sexual", label: "hentai" });
    assert.deepEqual(matchUnsafeSearchQuery("I wanna die"), { safetyAlert: "self-harm", label: "want to die" });
  });

  it("resolves mixed queries to the most urgent tier", () => {
    assert.equal(matchUnsafeSearchQuery("porn and how to kill myself")?.safetyAlert, "self-harm");
    assert.equal(matchUnsafeSearchQuery("buy weed and porn")?.safetyAlert, "drugs");
  });
});

describe("ClassPilot AI-tool detection", () => {
  it("does not let google.com make a Google-hosted assistant educational", async () => {
    const gemini = await classifyUrl("https://gemini.google.com/app", "Gemini");
    assert.equal(gemini?.category, "non-educational");
    assert.equal(gemini?.safetyAlert, null);
    assert.equal(gemini?.source, "ai-tool");
    assert.equal(gemini?.matchedTerm, "gemini.google.com");
  });

  it("classifies assistants as non-educational and caches the verdict", async () => {
    const first = await classifyUrl("https://chatgpt.com/c/abc", "ChatGPT");
    const second = await classifyUrl("https://chatgpt.com/c/def", "ChatGPT");
    assert.equal(first?.source, "ai-tool");
    assert.equal(first?.matchedTerm, "chatgpt.com");
    assert.equal(first, second);
  });
});
