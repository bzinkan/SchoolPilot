import assert from "node:assert/strict";
import { test } from "node:test";

test("external AI is paused with credentials and feature switches present", async (t) => {
  const previousEnv = { ...process.env };
  t.after(() => { process.env = previousEnv; });
  delete process.env.SCHOOLPILOT_EXTERNAL_AI_MODE;
  process.env.CLASSPILOT_BROWSER_GEMINI_MODE = "on";
  process.env.AI_CHAT_ENABLED = "true";
  process.env.ANTHROPIC_API_KEY = "synthetic-provider-key";
  process.env.GEMINI_API_KEY = "synthetic-provider-key";
  process.env.MYDESK_MODE = "on";
  process.env.MYDESK_AI_IMPORT_MODE = "on";
  process.env.STUDENT_INFORMATION_AI_IMPORT_MODE = "on";
  process.env.DATABASE_URL = "postgres://fixture:fixture@127.0.0.1:1/unused";
  process.env.DATABASE_URL_PRIVILEGED = process.env.DATABASE_URL;
  process.env.REDIS_URL = "";
  const outbound: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    outbound.push(String(input));
    throw new Error("Unexpected external transport");
  });

  const { externalAiProvidersEnabled, guardedExternalAiFetch } = await import("../src/config/externalAi.js");
  assert.equal(externalAiProvidersEnabled(), false);
  for (const mode of ["off", "ON", "true", ""]) {
    assert.equal(externalAiProvidersEnabled({ SCHOOLPILOT_EXTERNAL_AI_MODE: mode }), false);
  }
  assert.equal(externalAiProvidersEnabled({ SCHOOLPILOT_EXTERNAL_AI_MODE: "on" }), true);
  await assert.rejects(() => guardedExternalAiFetch()("https://provider.invalid"), /paused/i);

  const { classifyUrl, classifyChatText, classifyEmail, isAiAvailable } = await import("../src/services/aiClassification.js");
  assert.equal(isAiAvailable(), false);
  assert.equal((await classifyUrl("https://docs.google.com/document"))?.category, "educational");
  assert.equal((await classifyUrl("https://unique-fixture.invalid/path", "Synthetic"))?.source, "unknown");
  assert.equal(await classifyChatText("synthetic content"), null);
  assert.equal(await classifyEmail({ from: "sender@example.invalid", to: [], subject: "synthetic", body: "fixture", direction: "inbound" }), null);

  const { isChatAvailable, sendMessage, confirmAction } = await import("../src/services/chatService.js");
  const context = {
    schoolId: "fixture", userId: "fixture", schoolName: "School",
    userName: "Staff", userRole: "teacher", licensedProducts: [],
  };
  assert.equal(isChatAvailable(), false);
  assert.equal((await sendMessage("pending", "fixture", context).next()).value?.type, "error");
  assert.equal((await confirmAction("pending", true, context).next()).value?.type, "error");

  const { myDeskImportsEnabledForSchool } = await import("../src/services/mydeskImportsValidation.js");
  const { studentInformationImportEnabled, INFORMATION_PROMPT_VERSION } = await import("../src/services/studentInformationValidation.js");
  assert.equal(myDeskImportsEnabledForSchool("fixture"), false);
  assert.equal(studentInformationImportEnabled(), false);
  const { createImportProviderTransport } = await import("../src/services/mydeskImportProcessing.js");
  const paperworkTransport = createImportProviderTransport("synthetic-key", globalThis.fetch);
  await assert.rejects(paperworkTransport({ model: "synthetic", max_tokens: 1, messages: [] }, new AbortController().signal), /paused/i);
  const { createInformationExtractor } = await import("../src/services/studentInformationProcessing.js");
  const contactExtractor = createInformationExtractor({ model: "synthetic", promptVersion: INFORMATION_PROMPT_VERSION });
  await assert.rejects(contactExtractor({ bytes: Buffer.from("synthetic"), contentType: "text/plain" }), /paused/i);

  const { claimMyDeskImportJobs } = await import("../src/services/mydeskImportWorker.js");
  const { claimStudentInformationJobs } = await import("../src/services/studentInformationWorker.js");
  assert.deepEqual(await claimMyDeskImportJobs(), []);
  assert.deepEqual(await claimStudentInformationJobs(), []);
  assert.deepEqual(outbound, []);
});
