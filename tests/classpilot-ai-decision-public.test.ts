import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  redactClasspilotInternalIdentifiers,
  toPublicAiDecisionTimelineMetadata,
  toPublicBrowserSafetyTimelineMetadata,
  toPublicClasspilotAiTimelineMetadata,
  toPublicClasspilotAiDecision,
  toPublicClasspilotTimelineEvent,
} from "../dist/services/classpilotPublicAiDecision.js";

function rawDecision(overrides: Record<string, unknown> = {}): any {
  return {
    id: "decision-public-reference",
    schoolId: "school-internal",
    studentId: "student-internal",
    deviceId: "device-internal",
    heartbeatId: "heartbeat-internal",
    url: "https://example.edu/resource",
    title: "Example resource",
    domain: "example.edu",
    category: "educational",
    safetyAlert: null,
    confidence: 91,
    reasoning: "Known educational resource",
    matchedRule: "known-domain",
    actionTaken: "allow",
    teacherIntentSource: null,
    reviewStatus: "confirmed",
    reviewNote: "Reviewed",
    reviewedBy: "user-internal",
    reviewedAt: new Date("2026-08-13T12:05:00.000Z"),
    metadata: {
      deviceId: "nested-device",
      nested: { heartbeat_id: "nested-heartbeat" },
    },
    createdAt: new Date("2026-08-13T12:00:00.000Z"),
    ...overrides,
  };
}

describe("ClassPilot public AI decision serialization", () => {
  it("returns only the narrow review DTO and omits internal bindings", () => {
    const dto = toPublicClasspilotAiDecision(rawDecision());

    assert.deepEqual(Object.keys(dto).sort(), [
      "actionTaken",
      "category",
      "confidence",
      "createdAt",
      "domain",
      "id",
      "matchedRule",
      "reasoning",
      "reviewNote",
      "reviewStatus",
      "reviewedAt",
      "safetyAlert",
      "teacherIntentSource",
      "title",
      "url",
    ]);
    const serialized = JSON.stringify(dto);
    assert.equal(serialized.includes("deviceId"), false);
    assert.equal(serialized.includes("heartbeatId"), false);
    assert.equal(serialized.includes("schoolId"), false);
    assert.equal(serialized.includes("studentId"), false);
    assert.equal(serialized.includes("reviewedBy"), false);
    assert.equal(serialized.includes("internal"), false);
  });

  it("recursively removes camel, snake, kebab, and array-nested identifier keys", () => {
    const safe = redactClasspilotInternalIdentifiers({
      domain: "example.edu",
      valid: true,
      deviceId: "device-1",
      heartbeat_id: "heartbeat-1",
      "student-session-id": "session-1",
      nested: {
        actorUserId: "user-1",
        reviewedBy: "reviewer-1",
        labels: [
          { source_id: "source-1", outcome: "blocked" },
          { relatedIds: ["one", "two"], count: 2 },
        ],
      },
    });

    assert.deepEqual(safe, {
      domain: "example.edu",
      valid: true,
      nested: {
        labels: [{ outcome: "blocked" }, { count: 2 }],
      },
    });
  });

  it("keeps unified timeline decision and persisted browser metadata identifier-free", () => {
    const decisionMetadata = toPublicAiDecisionTimelineMetadata(rawDecision());
    const browserMetadata = toPublicBrowserSafetyTimelineMetadata({
      domain: "example.edu",
      category: "unknown",
      safetyAlert: "violence",
      confidence: 82,
      source: "classifier",
      teacherIntentSource: "flight-path",
      deviceId: "must-not-copy",
      heartbeatId: "must-not-copy",
    });
    const timeline = toPublicClasspilotTimelineEvent({
      id: "timeline-public-reference",
      schoolId: "school-internal",
      studentId: "student-internal",
      caseId: "case-internal",
      sourceId: "decision-internal",
      actorUserId: "user-internal",
      eventType: "browser_safety_alert",
      sourceType: "classpilot_ai",
      title: "Browser safety alert",
      summary: "Observed browser telemetry",
      severity: "high",
      metadata: {
        ...browserMetadata,
        legacy: {
          deviceId: "legacy-device",
          heartbeat_id: "legacy-heartbeat",
          outcome: "closed",
        },
      },
      occurredAt: new Date("2026-08-13T12:00:00.000Z"),
      persisted: true,
    });

    assert.deepEqual(Object.keys(decisionMetadata).sort(), [
      "actionTaken",
      "category",
      "confidence",
      "domain",
      "matchedRule",
      "reviewStatus",
      "safetyAlert",
      "teacherIntentSource",
    ]);
    assert.equal(JSON.stringify(decisionMetadata).includes("internal"), false);
    assert.equal(JSON.stringify(browserMetadata).includes("must-not-copy"), false);
    assert.deepEqual(timeline.metadata, {
      ...browserMetadata,
      legacy: { outcome: "closed" },
    });
    assert.equal("schoolId" in (timeline as any), false);
    assert.equal("studentId" in (timeline as any), false);
    assert.equal("caseId" in (timeline as any), false);
    assert.equal("sourceId" in (timeline as any), false);
    assert.equal("actorUserId" in (timeline as any), false);
  });

  it("allowlists ClassPilot AI timeline metadata from legacy persisted rows", () => {
    const metadata = toPublicClasspilotAiTimelineMetadata({
      domain: "example.edu",
      actionTaken: "close-tab",
      reviewStatus: "confirmed",
      deviceId: "private-device",
      nested: { heartbeatId: "private-heartbeat", outcome: "closed" },
      arbitraryLegacyField: "not part of the public contract",
    });

    assert.deepEqual(metadata, {
      domain: "example.edu",
      actionTaken: "close-tab",
      reviewStatus: "confirmed",
    });
  });
});
