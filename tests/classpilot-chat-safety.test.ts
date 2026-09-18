import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { CHAT_SAFETY_RULES, CHAT_SAFETY_RULESET_VERSION, classifyChatMessage } from "../src/services/aiClassification.js";
import { chatSafetyScanMode, scanStudentChatMessage, type ChatSafetyScanDependencies } from "../src/services/classpilotChatSafety.js";
import { snapshotRuntimePerformanceMetrics } from "../src/services/runtimePerformanceMetrics.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("class chat safety lexicon", () => {
  it("flags first-person disclosures, threats, weapons at school and told-to-die bullying", () => {
    const hits: Array<[string, string]> = [
      ["i want to die", "self-harm"],
      ["I really wanna disappear", "self-harm"],
      ["i dont want to be here anymore", "self-harm"],
      ["im gonna kill myself tonight", "self-harm"],
      ["nobody would care if i was gone", "self-harm"],
      ["everyone would be better off without me", "self-harm"],
      ["ive been cutting myself", "self-harm"],
      ["im going to kill you after class", "violence"],
      ["gonna shoot up the school tomorrow", "violence"],
      ["ill bring my knife tomorrow", "violence"],
      ["i have a gun in my backpack", "weapons"],
      ["kys loser", "bullying"],
      ["everyone hates you", "bullying"],
      ["how to tie a noose", "self-harm"],
      ["where to buy weed near school", "drugs"],
    ];
    for (const [text, alert] of hits) {
      const match = classifyChatMessage(text);
      assert.equal(match?.safetyAlert, alert, text);
      assert.ok(match?.label, text);
    }
    assert.equal(classifyChatMessage("how to tie a noose")?.source, "search-lexicon");
    assert.equal(classifyChatMessage("i want to die")?.source, "search-lexicon", "the shared search lexicon runs first");
    assert.equal(classifyChatMessage("nobody would care if i was gone")?.source, "chat-lexicon");
  });

  it("stays quiet on ordinary class chat, negations, games, help-seeking and the mockingbird", () => {
    for (const text of [
      "can we go gym still?????",
      "MR.ZZZZ!!!!!!!",
      "i finished the worksheet",
      "the essay on to kill a mockingbird is due friday",
      "i dont want to die in this minecraft game lol",
      "how do i stop wanting to die",
      "i do not want to hurt myself anymore, who can i talk to",
      "my brother says everyone likes you",
      "we watched suicide squad last night",
      "im going to kill it at the recital",
      "",
      "   ",
    ]) {
      assert.equal(classifyChatMessage(text), null, text);
    }
  });

  it("keeps the ruleset small, versioned and explicit about who paused nothing", () => {
    assert.match(CHAT_SAFETY_RULESET_VERSION, /^chat-safety-\d{4}-\d{2}-\d{2}\.\d+$/);
    const alerts = CHAT_SAFETY_RULES.map((tier) => tier.safetyAlert);
    assert.deepEqual(alerts, ["self-harm", "violence", "weapons", "bullying"], "most urgent tier first");
    assert.ok(CHAT_SAFETY_RULES.every((tier) => tier.rules.length > 0 && tier.rules.every((rule) => rule.label && rule.pattern instanceof RegExp)));
  });
});

describe("class chat safety scanner", () => {
  const base = {
    schoolId: "11111111-1111-4111-8111-111111111111",
    studentId: "22222222-2222-4222-8222-222222222222",
    messageId: "33333333-3333-4333-8333-333333333333",
    deviceId: "44444444-4444-4444-8444-444444444444",
    teachingSessionId: "55555555-5555-4555-8555-555555555555",
  };
  function harness(overrides: Partial<ChatSafetyScanDependencies> = {}) {
    const recorded: Array<Parameters<ChatSafetyScanDependencies["record"]>[0]> = [];
    const enriched: string[] = [];
    const claims: string[] = [];
    const warnings: string[] = [];
    const deps: ChatSafetyScanDependencies = {
      classify: classifyChatMessage,
      enrich: async (content) => { enriched.push(content); return { safetyAlert: "self-harm", severity: "critical", confidence: 92, reasoning: "Explicit plan for tonight", modelVersion: "test-model" }; },
      claim: async ({ domain }) => { claims.push(domain); return true; },
      record: async (observation) => { recorded.push(observation); return { suppressed: false, created: true, caseId: "case", alertId: "alert" }; },
      mode: () => "hit",
      log: { warn: (line) => warnings.push(line) },
      ...overrides,
    };
    return { deps, recorded, enriched, claims, warnings };
  }

  it("records a lexicon hit as a chat observation and lets the provider only raise the grade", async () => {
    snapshotRuntimePerformanceMetrics({ reset: true });
    const { deps, recorded, enriched, claims } = harness();
    const result = await scanStudentChatMessage({ ...base, content: "im gonna kill myself tonight" }, deps);
    assert.deepEqual(result, { safetyAlert: "self-harm", recorded: true, created: true, classificationSource: "chat-ai" });
    assert.equal(recorded.length, 1);
    const observation = recorded[0]!;
    assert.equal(observation.sourceType, "chat");
    assert.equal(observation.sourceId, base.messageId);
    assert.equal(observation.url, null);
    assert.equal(observation.safetyAlert, "self-harm");
    assert.equal(observation.severity, "critical", "the provider raised high to critical");
    assert.equal(observation.classificationSource, "chat-ai");
    assert.equal(observation.matchedTerm, classifyChatMessage("im gonna kill myself tonight")?.label);
    assert.equal(observation.rulesetVersion, CHAT_SAFETY_RULESET_VERSION);
    assert.equal(observation.modelVersion, "test-model");
    assert.equal(observation.confidence, 92);
    assert.equal(observation.teachingSessionId, base.teachingSessionId);
    assert.deepEqual(enriched, ["im gonna kill myself tonight"], "the provider saw the message only because the lexicon matched first");
    assert.deepEqual(claims, [`chat:${base.studentId}:self-harm`]);
    assert.equal(snapshotRuntimePerformanceMetrics({ reset: true }).counters.chatSafetyAlertsRecorded, 1);
  });

  it("never sends unflagged text to the provider, and honours the off switch", async () => {
    const { deps, recorded, enriched } = harness();
    assert.deepEqual(await scanStudentChatMessage({ ...base, content: "can we go gym still?" }, deps),
      { safetyAlert: null, recorded: false, created: false, classificationSource: null });
    assert.equal(enriched.length, 0);
    assert.equal(recorded.length, 0);
    const off = harness({ mode: () => "off" });
    await scanStudentChatMessage({ ...base, content: "i want to die" }, off.deps);
    assert.equal(off.enriched.length, 0, "off mode keeps every message inside the system");
    assert.equal(off.recorded[0]?.classificationSource, "chat-lexicon");
    assert.equal(off.recorded[0]?.severity, "high");
    assert.equal(chatSafetyScanMode(), process.env.CLASSPILOT_CHAT_AI_SCAN_MODE === "off" ? "off" : "hit");
  });

  it("keeps the lexicon alert when the provider fails, is throttled, or the claim is lost", async () => {
    const failing = harness({ enrich: async () => { throw new Error("provider down"); } });
    const result = await scanStudentChatMessage({ ...base, content: "i want to die" }, failing.deps);
    assert.equal(result.recorded, true);
    assert.equal(failing.recorded[0]?.classificationSource, "chat-lexicon");
    const unavailable = harness({ enrich: async () => null });
    await scanStudentChatMessage({ ...base, content: "i want to die" }, unavailable.deps);
    assert.equal(unavailable.recorded[0]?.classificationSource, "chat-lexicon");
    const unclaimed = harness({ claim: async () => false });
    await scanStudentChatMessage({ ...base, content: "i want to die" }, unclaimed.deps);
    assert.equal(unclaimed.enriched.length, 0, "a repeat inside the cooldown keeps the lexicon grade");
    assert.equal(unclaimed.recorded.length, 1);
    const claimError = harness({ claim: async () => { throw new Error("redis down"); } });
    await scanStudentChatMessage({ ...base, content: "i want to die" }, claimError.deps);
    assert.equal(claimError.recorded.length, 1);
  });

  it("never throws into the send path and never logs content", async () => {
    snapshotRuntimePerformanceMetrics({ reset: true });
    const { deps, warnings } = harness({ record: async () => { throw Object.assign(new Error("db down"), { code: "ECONNRESET" }); } });
    const result = await scanStudentChatMessage({ ...base, content: "i want to die" }, deps);
    assert.deepEqual(result, { safetyAlert: null, recorded: false, created: false, classificationSource: null });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /safety scan failed school=.* student=.* message=.* error=ECONNRESET/);
    assert.doesNotMatch(warnings[0]!, /want to die/);
    assert.equal(snapshotRuntimePerformanceMetrics({ reset: true }).counters.chatSafetyScanFailed, 1);
    const brokenLog = harness({ record: async () => { throw new Error("x"); }, log: { warn: () => { throw new Error("sink down"); } } });
    await assert.doesNotReject(scanStudentChatMessage({ ...base, content: "i want to die" }, brokenLog.deps));
  });

  it("is hooked after fan-out on both student-message paths and documented in the env example", async () => {
    const [chat, env, counters] = await Promise.all([
      source("src/routes/classpilot/chat.ts"),
      source(".env.example"),
      source("src/services/runtimePerformanceMetrics.ts"),
    ]);
    const send = chat.slice(chat.indexOf('router.post("/student/send-message"'), chat.indexOf('router.post("/device/chat-acks"'));
    assert.equal(send.match(/void scanStudentChatMessage\(/g)?.length, 2, "scheduled and class-session paths both scan");
    assert.ok(send.indexOf("reportStudentChatFanOut(") < send.indexOf("void scanStudentChatMessage("));
    assert.doesNotMatch(send, /await scanStudentChatMessage/, "the scan never delays the send response");
    assert.match(env, /CLASSPILOT_CHAT_AI_SCAN_MODE=hit/);
    assert.match(counters, /"chatSafetyScanFailed", "chatSafetyAlertsRecorded"/);
  });
});
