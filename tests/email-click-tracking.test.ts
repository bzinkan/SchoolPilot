import assert from "node:assert/strict";
import { test } from "node:test";
import sgMail from "@sendgrid/mail";

// Exercise the provider payload without permitting a real email submission.
process.env.SENDGRID_API_KEY = `SG.${"x".repeat(22)}.${"y".repeat(43)}`;
const { sendEmailWithResult } = await import("../src/services/email.js");
const reportUrl = "https://school-pilot.net/classpilot/admin/safety?case=fixture-case";

for (const content of [{ text: reportUrl }, { html: `<a href="${reportUrl}">Review report</a>` }]) {
  test(`safety report links bypass rewriting in ${"text" in content ? "plain text" : "HTML"} email`, async t => {
    const messages: Array<Record<string, unknown>> = [];
    const send = t.mock.method(sgMail, "send", async (message: Record<string, unknown>) => {
      messages.push(message);
      return [{ headers: { "x-message-id": "fixture-accepted" } }];
    });
    const result = await sendEmailWithResult({
      to: "fixture@example.invalid", subject: "Synthetic safety report", ...content, disableClickTracking: true,
    });
    assert.deepEqual(result, { status: "sent", providerMessageId: "fixture-accepted" });
    assert.equal(send.mock.calls.length, 1);
    const message = messages[0]!;
    assert.deepEqual(message.trackingSettings, { clickTracking: { enable: false, enableText: false } });
    assert.equal(message.text ?? message.html, content.text ?? content.html);
  });
}

test("ordinary mail inherits provider tracking settings unless explicitly disabled", async t => {
  const messages: Array<Record<string, unknown>> = [];
  const send = t.mock.method(sgMail, "send", async (message: Record<string, unknown>) => {
    messages.push(message);
    return [{ headers: { "x-message-id": "ordinary-accepted" } }];
  });
  for (const options of [{}, { disableClickTracking: false }]) {
    assert.equal((await sendEmailWithResult({ to: "fixture@example.invalid", subject: "Ordinary fixture", text: reportUrl, ...options })).status, "sent");
  }
  assert.equal(send.mock.calls.length, 2);
  for (const message of messages) assert.equal(Object.hasOwn(message, "trackingSettings"), false);
});
