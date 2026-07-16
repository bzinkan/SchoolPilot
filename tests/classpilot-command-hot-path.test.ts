import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("ClassPilot command and ACK hot path", () => {
  it("publishes device commands in one ordered Redis batch and refreshes the sent summary once", () => {
    const dispatcher = source("src/services/classpilotCommandDispatcher.ts");
    const redis = source("src/realtime/ws-redis.ts");
    const dispatchSection = dispatcher.slice(
      dispatcher.indexOf("const sentTargets"),
      dispatcher.indexOf("const command = await getClasspilotCommandByIdAndSchool")
    );

    assert.match(dispatchSection, /remotePublications\.push\(\{[\s\S]*?deliveryCandidates\.push\(target\)/);
    assert.match(dispatchSection, /await publishWSBatch\(remotePublications\)/);
    assert.doesNotMatch(dispatchSection, /await publishWS\(\{ kind: "device"/);
    assert.match(dispatchSection, /redisPublishSucceeded = publicationResults\.every\(Boolean\)/);
    assert.match(
      dispatchSection,
      /await publishWSBatch\(remotePublications\)[\s\S]*?sentTargets\.push\(\.\.\.deliveryCandidates\)/
    );
    assert.doesNotMatch(dispatchSection, /locallyDelivered \|\| publicationResults\[index\]/);
    assert.equal(
      dispatchSection.match(/markClasspilotCommandTargetsSent\(/g)?.length,
      1
    );
    assert.doesNotMatch(dispatchSection, /updateClasspilotCommandSummary/);

    const batchStart = redis.indexOf("export async function publishWSBatch");
    const batchSection = redis.slice(
      batchStart,
      redis.indexOf("\nregisterCacheInvalidationPublisher", batchStart)
    );
    assert.match(batchSection, /const pipeline = redisPublisher\.multi\(\)/);
    assert.match(batchSection, /for \(const payload of serialized\)[\s\S]*?pipeline\.publish\(redisChannel, payload\)/);
    assert.match(batchSection, /await pipeline\.exec\(\)/);
    assert.match(batchSection, /catch \(error\)[\s\S]*?batch publish failed:[\s\S]*?items\.map\(\(\) => false\)/);
  });

  it("coalesces ACK summaries before a revisioned snapshot without holding the DB lock during publication", () => {
    const storage = source("src/services/storage.ts");
    const websocket = source("src/realtime/websocket.ts");
    const ackUpdateSection = storage.slice(
      storage.indexOf("export async function updateClasspilotCommandTargetAck"),
      storage.indexOf("export async function getClasspilotCommandByIdAndSchool")
    );
    assert.doesNotMatch(ackUpdateSection, /updateClasspilotCommandSummary/);

    const commandUpdateSection = websocket.slice(
      websocket.indexOf("const publishCommandUpdate"),
      websocket.indexOf("function drainCommandUpdates")
    );
    const summaryIndex = commandUpdateSection.indexOf("updateClasspilotCommandSummary(state.commandId)");
    const snapshotIndex = commandUpdateSection.indexOf("withClasspilotCommandBroadcastLock");
    assert.ok(summaryIndex >= 0 && snapshotIndex > summaryIndex);
    assert.match(websocket, /setTimeout\(\(\) => \{[\s\S]*?\}, 50\)/);

    const lockSection = storage.slice(
      storage.indexOf("export async function withClasspilotCommandBroadcastLock"),
      storage.indexOf("export async function getRecentClasspilotCommands")
    );
    assert.match(lockSection, /const snapshot = await db\.transaction/);
    assert.ok(lockSection.indexOf("return callback(") > lockSection.indexOf("if (!snapshot) return undefined"));
    const transactionBody = lockSection.slice(0, lockSection.indexOf("if (!snapshot) return undefined"));
    assert.doesNotMatch(transactionBody, /return callback\(/);

    const redis = source("src/realtime/ws-redis.ts");
    const orderedScript = redis.slice(
      redis.indexOf("export const ORDERED_PUBLISH_SCRIPT"),
      redis.indexOf("const MAX_ORDERED_DELIVERY_REVISIONS")
    );
    assert.ok(orderedScript.indexOf("redis.call('SET'") < orderedScript.indexOf("redis.call('PUBLISH'"));
    assert.doesNotMatch(orderedScript, /if subscribers > 0/);

    const globalPublish = commandUpdateSection.indexOf(
      "const outcome = await publishOrderedWS"
    );
    const localPublish = commandUpdateSection.indexOf(
      "broadcastToTeachersLocal(state.schoolId, payload)",
      globalPublish
    );
    assert.ok(globalPublish >= 0 && localPublish > globalPublish);
    assert.match(
      commandUpdateSection.slice(globalPublish, localPublish),
      /outcome\.status === "accepted"/
    );
    assert.match(
      commandUpdateSection,
      /outcome\.subscriberCount === 0[\s\S]*?publication had no subscribers/
    );
    assert.match(
      commandUpdateSection,
      /outcome\.status === "stale"[\s\S]*?publication was superseded/
    );
  });

  it("emits aggregate PII-free phase metrics for command and ACK work", () => {
    const dispatcher = source("src/services/classpilotCommandDispatcher.ts");
    const websocket = source("src/realtime/websocket.ts");
    const redis = source("src/realtime/ws-redis.ts");

    for (const phase of [
      "command_local_delivery",
      "command_redis_batch",
      "command_mark_sent",
    ]) {
      assert.match(dispatcher, new RegExp(`"${phase}"`));
    }
    for (const phase of [
      "ack_target_update",
      "ack_summary_refresh",
      "ack_snapshot_publish",
      "ack_redis_publish",
    ]) {
      assert.match(websocket, new RegExp(`"${phase}"`));
    }

    const metricSection = redis.slice(
      redis.indexOf("export function recordCommandHotPathPhase"),
      redis.indexOf("console.log(`[Redis]")
    );
    assert.match(metricSection, /count:/);
    assert.match(metricSection, /failures:/);
    assert.match(metricSection, /totalDurationMs:/);
    assert.match(metricSection, /maxDurationMs:/);
    assert.doesNotMatch(metricSection, /schoolId|userId|deviceId|commandId|message|payload/);
  });
});
