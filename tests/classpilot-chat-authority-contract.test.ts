import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ClassPilot chat mutations require immutable session staff authority", async () => {
  const [route, storage] = await Promise.all([
    readFile(new URL("../src/routes/classpilot/chat.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/services/storage.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /if \(!options\.mutate && isClasspilotAdmin\(req, res\)\) return session/);
  assert.match(route, /teacher\/reply[\s\S]*createTeacherChatReplyWithDelivery/);
  assert.match(route, /teacher\/messages\/:messageId[\s\S]*deleteAuthorizedClasspilotChatMessage/);
  assert.match(route, /teacher\/dismiss-hand\/:studentId[\s\S]*dismissAuthorizedClasspilotStudentHand/);
  assert.match(route, /teacher\/close-chat[\s\S]*authorizeClasspilotTeacherCloseChat/);

  const mutation = storage.slice(
    storage.indexOf("async function withAuthorizedClasspilotTeacherStudentAction"),
    storage.indexOf("export async function getChatMessages")
  );
  assert.match(mutation, /assertClasspilotEntitled\(options\.schoolId, transactionDb, \{ lock: true \}\)/);
  assert.match(mutation, /classpilotSessionStaff[\s\S]*staffId, options\.actorId/);
  assert.match(mutation, /getActiveSupervisionForStudents/);
  assert.match(mutation, /classpilotStudentControlStates/);
  assert.match(mutation, /studentSessions[\s\S]*\.for\("share"\)/);
});
