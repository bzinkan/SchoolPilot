import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { classifyImmediateEducationalUrl, classifyUrl } from "../src/services/aiClassification.js";
import { sanitizeClasspilotHeartbeatNavigationForSso } from "../src/services/classpilotHeartbeatSsoSanitizer.js";

const source = readFileSync(new URL("../src/routes/classpilot/devices.ts", import.meta.url), "utf8");
const start = source.indexOf("    const heartbeatDbResult = await runWithTenantContext(");
const end = source.indexOf("    recordHeartbeatHotPathTiming(", start);
assert.ok(start > 0 && end > start);
const executable = ts.transpileModule(`async function record() { ${source.slice(start, end)}\nreturn heartbeatDbResult; } record;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const cacheStart = source.indexOf("    const classificationPending = ");
const cacheEnd = source.indexOf("    // A write-through cache must never", cacheStart);
assert.ok(cacheStart > end && cacheEnd > cacheStart);
const cacheExecutable = ts.transpileModule(`function cache() { ${source.slice(cacheStart, cacheEnd)} } cache;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
type Fields = Record<string, unknown>;

function cacheProjection(result: Fields) {
  const tile: Fields[] = [], realtime: Fields[] = [];
  const context = {
    heartbeat: result.heartbeat, persistedImmediateClassification: result.persistedImmediateClassification,
    schoolId: "school", studentId: "student", deviceId: "device", studentSessionId: "session", studentEmail: "synthetic@school.example",
    activeTabUrl: "https://www.ixl.com/math", activeTabTitle: "Learning", activeTabRef: "opaque-ref", favicon: undefined, allOpenTabs: [],
    screenLocked: false, flightPathActive: false, activeFlightPathName: undefined, isScreenSharing: false, isScreenRecording: false,
    cameraActive: false, extensionVersion: "2.9.7", chromeVersion: "120", screenshotHealth: undefined, restrictionAuthState: "idle",
    tabSnapshotRevision: 3, trackingStatus: "ACTIVE", clientProtocolVersion: 2, protocol: { acceptedCapabilities: [] },
    extensionCapabilities: [], capabilities: [], classroomState: null, controlState: null, enforcementHealth: undefined,
    appliedAuthPolicyRevision: undefined, appliedFabRevision: undefined, focusRecord() { return {}; },
    writeHeartbeatTileCache(value: Fields) { tile.push(value); return true; },
    writeClasspilotRealtimeStatus(value: Fields) { realtime.push(value); return { snapshot: value }; },
  };
  const run: () => void = runInNewContext(cacheExecutable, context); run();
  return { tile: tile[0]!, realtime: realtime[0]! };
}

async function record(options: { url?: string; schoolDomain?: string; returnMode?: "missing" | "mismatch" | "replaced"; sso?: boolean } = {}) {
  const writes: Fields[] = [], classifiedUrls: string[] = [];
  const context = {
    Promise, schoolId: "school", studentId: "student", deviceId: "device", studentSessionId: "session",
    activeTabUrl: options.url ?? "https://www.ixl.com/math", activeTabTitle: "Learning", favicon: undefined, allOpenTabs: [],
    screenLocked: false, flightPathActive: false, activeFlightPathName: undefined, isScreenSharing: false, isScreenRecording: false,
    cameraActive: false, extensionVersion: "2.9.7", chromeVersion: "120", screenshotHealth: undefined, restrictionAuthState: "idle",
    protocol: { acceptedCapabilities: [] }, res: { locals: { studentSessionId: "session" } },
    // Untrusted classification fields must never be copied into INSERT input.
    req: { body: { aiCategory: "non-educational", contentCategory: "Gaming", teacherIntentSource: "client-forged", safetyAlert: "violence" } },
    async runWithTenantContext(scope: Fields, action: () => Promise<unknown>) { assert.equal(scope.schoolId, "school"); return action(); },
    async getHeartbeatTrackingSettingsForSchool() { return {}; }, resolveClasspilotMonitoringPolicy() { return { mode: "full" }; },
    async getClasspilotHeartbeatPersistenceContext() { return {
      school: { status: "active", domain: options.schoolDomain ?? "school.example" }, privacyControlState: null,
      ssoPolicy: { revision: 1, policy: { schemaVersion: 1, enabled: options.sso === true, defaultProfileId: "google", attemptTtlSeconds: 300,
        profiles: [{ id: "google", name: "Google", startUrl: "https://accounts.google.com", hostRules: [{ hostname: "accounts.google.com", includeSubdomains: false }] }] } },
    }; },
    sanitizeClasspilotHeartbeatNavigationForSso,
    classifyImmediateEducationalUrl(url: string, options: Parameters<typeof classifyImmediateEducationalUrl>[1]) {
      classifiedUrls.push(url); return classifyImmediateEducationalUrl(url, options);
    },
    async createHeartbeatAndRefreshPresence(value: Fields, session: string) {
      assert.equal(session, "session"); writes.push(value);
      if (options.returnMode === "replaced") return { outcome: "replaced_session" };
      return { outcome: "recorded", id: "heartbeat", timestamp: new Date(), ...(options.returnMode === "missing" ? {} : {
        aiCategory: options.returnMode === "mismatch" ? "unknown" : value.aiCategory,
        contentCategory: value.contentCategory, teacherIntentSource: value.teacherIntentSource, safetyAlert: value.safetyAlert,
      }) };
    },
  };
  const run: () => Promise<Fields> = runInNewContext(executable, context);
  return { result: await run(), writes, classifiedUrls };
}

test("known educational classification is server-derived and confirmed by INSERT RETURNING", async () => {
  const f = await record();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0]?.aiCategory, "educational");
  assert.equal(f.writes[0]?.contentCategory, "Education");
  assert.equal(f.writes[0]?.teacherIntentSource, null);
  assert.equal(f.writes[0]?.safetyAlert, null);
  const classification = f.result.persistedImmediateClassification as Fields;
  assert.equal(classification.category, "educational");
  assert.equal(classification.source, "known-list");
  const caches = cacheProjection(f.result);
  assert.equal(caches.tile.aiCategory, "educational");
  assert.equal(caches.tile.contentCategory, "Education");
  assert.equal(caches.tile.classificationPending, false);
  assert.equal(caches.realtime.aiClassification, classification);
  assert.equal(caches.realtime.classificationPending, false);
});

test("missing or mismatched persisted fields keep the async classification fallback", async () => {
  for (const returnMode of ["missing", "mismatch"] as const) {
    const f = await record({ returnMode });
    assert.equal(f.result.persistedImmediateClassification, null, returnMode);
    const caches = cacheProjection(f.result);
    assert.equal(caches.tile.aiCategory, null);
    assert.equal(caches.realtime.aiClassification, undefined);
    assert.equal(caches.tile.classificationPending, true);
    assert.equal(caches.realtime.classificationPending, true);
  }
  const replaced = await record({ returnMode: "replaced" });
  assert.equal(replaced.result.outcome, "replaced_session");
  assert.equal(replaced.result.persistedImmediateClassification, undefined);
});

test("classification observes only SSO-sanitized navigation", async () => {
  const f = await record({ url: "https://accounts.google.com/signin?token=synthetic#secret", sso: true });
  assert.deepEqual(f.classifiedUrls, ["https://accounts.google.com"]);
  assert.equal(f.writes[0]?.activeTabUrl, "https://accounts.google.com");
  assert.equal(f.writes[0]?.activeTabTitle, "Signing in");
  assert.equal(f.writes[0]?.safetyAlert, null);
});

test("unsafe searches override cached educational domains and stay on the safety path", async () => {
  assert.equal(classifyImmediateEducationalUrl("https://google.com/search?q=math")?.category, "educational");
  const url = "https://google.com/search?q=how+to+kill+myself";
  assert.equal(classifyImmediateEducationalUrl(url), null);
  assert.equal((await classifyUrl(url, "Math"))?.safetyAlert, "self-harm");
  const f = await record({ url });
  assert.equal(f.result.persistedImmediateClassification, null);
  assert.equal(f.writes[0]?.aiCategory, null);
});

test("AI tools, unknown domains, internal URLs and school lookalikes retain the ordinary path", async () => {
  for (const url of ["https://gemini.google.com/", "https://unknown-classification.example/", "chrome://newtab", "chrome://google.com", "chrome-extension://google.com/page", "about:blank", "https://school.example.evil.test/"]) {
    const f = await record({ url });
    assert.equal(f.result.persistedImmediateClassification, null, url);
  }
  const allowed = await record({ url: "https://library.school.example/lesson" });
  assert.equal(Reflect.get(allowed.result.persistedImmediateClassification as object, "source"), "school-domain");
  const otherSchool = await record({ url: "https://library.school.example/lesson", schoolDomain: "another.example" });
  assert.equal(otherSchool.result.persistedImmediateClassification, null);
});
