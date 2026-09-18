import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  STUDENT_CHAT_COOLDOWN,
  resolveChatPause,
  studentChatRetryAfterMs,
} from "../src/services/classpilotChatChannelControl.js";
import { CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL, classpilotChatChannelControlMigration } from "../src/db/classpilotChatChannelControlMigration.js";
import { schoolPilot27Migrations } from "../src/db/migrations27.js";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

describe("student chat channel control", () => {
  it("pauses for the teacher first, then for a testing block unless the school opted out", () => {
    const cases: Array<[Parameters<typeof resolveChatPause>[0], ReturnType<typeof resolveChatPause>]> = [
      [{}, { messagesPaused: false, pauseReason: null }],
      [{ chatPaused: false, contextSource: null }, { messagesPaused: false, pauseReason: null }],
      [{ chatPaused: true }, { messagesPaused: true, pauseReason: "teacher" }],
      [{ chatPaused: true, contextSource: "scheduled_testing" }, { messagesPaused: true, pauseReason: "teacher" }],
      [{ contextSource: "scheduled_testing" }, { messagesPaused: true, pauseReason: "testing" }],
      [{ contextSource: "scheduled_testing", pauseChatDuringTesting: true }, { messagesPaused: true, pauseReason: "testing" }],
      [{ contextSource: "scheduled_testing", pauseChatDuringTesting: null }, { messagesPaused: true, pauseReason: "testing" }],
      [{ contextSource: "scheduled_testing", pauseChatDuringTesting: false }, { messagesPaused: false, pauseReason: null }],
      [{ contextSource: "scheduled_coverage" }, { messagesPaused: false, pauseReason: null }],
      [{ contextSource: "scheduled_coverage", chatPaused: true }, { messagesPaused: true, pauseReason: "teacher" }],
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(resolveChatPause(input), expected, JSON.stringify(input));
    }
  });

  it("tells the device a bounded wait even when the limiter window is stale or missing", () => {
    const now = 1_000_000;
    assert.equal(studentChatRetryAfterMs(new Date(now + 12_000), 30_000, now), 12_000);
    assert.equal(studentChatRetryAfterMs(new Date(now - 5), 30_000, now), 1_000, "an expired window never yields zero");
    assert.equal(studentChatRetryAfterMs(new Date(now + 999_999), 30_000, now), 30_000, "never longer than the window");
    assert.equal(studentChatRetryAfterMs(undefined, 30_000, now), 30_000);
    assert.equal(studentChatRetryAfterMs(new Date(Number.NaN), 30_000, now), 30_000);
    assert.deepEqual(STUDENT_CHAT_COOLDOWN, { burst: { windowMs: 30_000, max: 5 }, sustained: { windowMs: 300_000, max: 30 } });
  });

  it("registers an additive transactional migration before the staff identity contract and converges it locally", async () => {
    assert.match(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL, /ALTER TABLE session_settings\s+ADD COLUMN IF NOT EXISTS chat_paused BOOLEAN NOT NULL DEFAULT false/);
    assert.match(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL, /ALTER TABLE settings\s+ADD COLUMN IF NOT EXISTS pause_chat_during_testing BOOLEAN NOT NULL DEFAULT true/);
    assert.doesNotMatch(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL, /DROP|DELETE|UPDATE/);
    assert.equal(classpilotChatChannelControlMigration.mode, "transactional");
    const ids = schoolPilot27Migrations.map((migration) => migration.id);
    const index = ids.indexOf(classpilotChatChannelControlMigration.id);
    assert.ok(index >= 0, "migration is in the ordered manifest");
    assert.equal(ids.at(-1), "20260824_staff_identity_integrity_contract", "the staff identity contract migration stays last");
    assert.ok(index < ids.length - 1);
    const index_ts = await source("src/index.ts");
    assert.match(index_ts, /await pool\.query\(CLASSPILOT_SCHEDULED_CLASSROOM_SQL\);\s+await pool\.query\(CLASSPILOT_CHAT_CHANNEL_CONTROL_SQL\);/);
  });

  it("refuses a paused student send only after the hard channel check, on both authority paths", async () => {
    const [storage, tools, fab] = await Promise.all([
      source("src/services/storage.ts"),
      source("src/services/classpilotScheduledClassroomTools.ts"),
      source("src/services/classpilotFab.ts"),
    ]);
    const gate = storage.slice(
      storage.indexOf("async function withAuthorizedStudentFabMutation"),
      storage.indexOf("export async function createAuthorizedClasspilotStudentMessage")
    );
    assert.ok(gate.indexOf('"fab_feature_disabled"') < gate.indexOf('"chat_paused"'), "disabled wins over paused");
    assert.match(gate, /options\.feature === "chat" && perSession\?\.chatPaused === true/);
    assert.match(gate, /pauseReason: "teacher"/);

    const scheduledSend = tools.slice(
      tools.indexOf("export async function createScheduledStudentMessage"),
      tools.indexOf("export async function createScheduledTeacherReply")
    );
    assert.ok(scheduledSend.indexOf('"FAB_FEATURE_DISABLED"') < scheduledSend.indexOf('"CHAT_PAUSED"'));
    assert.match(scheduledSend, /if \(toggles\.messagesPaused\)/);
    const scheduledReply = tools.slice(
      tools.indexOf("export async function createScheduledTeacherReply"),
      tools.indexOf("export async function publishScheduledClassroomEvent")
    );
    assert.match(scheduledReply, /\.messagingChannelEnabled\)/, "a teacher can still reach a paused class");
    assert.doesNotMatch(scheduledReply, /CHAT_PAUSED/);

    // Every FAB snapshot shape carries the pause so 2.10.0 devices can show a banner
    // while 2.9.0 devices (which drop unknown keys) simply see messagingEnabled=false.
    const builder = fab.slice(fab.indexOf("export async function buildStudentFabState"), fab.indexOf("export async function getSessionStudentDeviceIds"));
    assert.match(builder, /messagesPaused: toggles\.messagesPaused, pauseReason: toggles\.pauseReason, handRaised: hands\.length > 0/, "scheduled classroom shape");
    assert.match(builder, /messagingEnabled: false,\s+handRaisingEnabled: false,\s+messagesPaused: false,\s+pauseReason: null,/, "disabled supervision shape");
    assert.match(builder, /sessionStates\.push\(\{[\s\S]*?messagesPaused: toggles\.messagesPaused,\s+pauseReason: toggles\.pauseReason,/, "per-session shape");
    assert.match(builder, /\r?\n    messagingEnabled,\r?\n    handRaisingEnabled,\r?\n    messagesPaused,\r?\n    pauseReason,\r?\n/, "aggregate class shape");
    assert.match(fab, /messagingEnabled: schoolMessagingEnabled && sessionMessagingEnabled && !pause\.messagesPaused/);
  });

  it("rate-limits student sends per student session with Redis-backed burst and sustained windows", async () => {
    const chat = await source("src/routes/classpilot/chat.ts");
    assert.match(chat, /router\.post\("\/student\/send-message", requireDeviceAuth, studentChatBurstLimiter, studentChatSustainedLimiter, requireClasspilotEntitlement/);
    assert.match(chat, /export const studentSessionRateLimitKey = pollResponseRateLimitKey/);
    assert.match(chat, /redisStore\("rl:classpilot-chat-burst:"\)|studentChatCooldownLimiter\("rl:classpilot-chat-burst:"/);
    assert.match(chat, /studentChatCooldownLimiter\("rl:classpilot-chat-sustained:"/);
    assert.match(chat, /keyGenerator: studentSessionRateLimitKey,\s+store: redisStore\(prefix\),\s+passOnStoreError: true/);
    assert.match(chat, /res\.set\("Retry-After"/);
    assert.match(chat, /code: "CHAT_COOLDOWN", retryAfterMs/);
    assert.match(chat, /typeof pauseReason === "string" \? \{ pauseReason \} : \{\}/, "403 chat_paused carries who paused it");
  });

  it("exposes the pause on every settings surface and advertises chatPauseV1 to the dashboard", async () => {
    const [sessions, activity, dashboard, devices, compat] = await Promise.all([
      source("src/routes/classpilot/sessions.ts"),
      source("src/routes/classpilot/dashboardActivity.ts"),
      source("src/routes/classpilot/dashboard.ts"),
      source("src/routes/classpilot/devices.ts"),
      source("src/routes/compat.ts"),
    ]);
    assert.match(sessions, /const \{ chatEnabled, raiseHandEnabled, chatPaused \} = req\.body/);
    assert.match(sessions, /action: chatPaused \? "classpilot\.chat\.paused" : "classpilot\.chat\.resumed"/);
    assert.match(activity, /\["chatEnabled", "raiseHandEnabled", "chatPaused", "expectedRevision"\]/);
    assert.match(activity, /action: body\.chatPaused \? "classpilot\.chat\.paused" : "classpilot\.chat\.resumed"/);
    assert.match(dashboard, /sessionChatPaused: fabToggles\.sessionChatPaused/);
    assert.match(dashboard, /pauseChatDuringTesting: schoolSettings\?\.pauseChatDuringTesting !== false/);
    assert.match(dashboard, /schoolData\.pauseChatDuringTesting = pauseChatDuringTesting/);
    assert.match(dashboard, /activeScheduledTestingStudentIds\(schoolId\)[\s\S]*syncClasspilotControlStatesToActiveDevices\(schoolId, testingStudentIds\)/);
    const settingsRoute = devices.slice(devices.indexOf('router.get("/extension/settings"'), devices.indexOf('router.get("/extension/settings"') + 8000);
    assert.match(settingsRoute, /messagesPaused: monitoringPolicy\.policyMode === "full" && settingsFab\.messagesPaused/);
    assert.match(settingsRoute, /pauseReason: monitoringPolicy\.policyMode === "full" \? settingsFab\.pauseReason : null/);
    assert.match(compat, /chatPauseV1: extensionCapabilities\.has\("chatPauseV1"\)/);
  });
});
