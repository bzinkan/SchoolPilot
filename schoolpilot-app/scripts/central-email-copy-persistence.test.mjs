import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";
const SCHOOL_ID = "33333333-3333-4333-8333-333333333333";

function settingsResponse(centralEmailRecipientUserId) {
  return {
    schoolName: "Central Copy Test School",
    retentionHours: "720",
    maxTabsPerStudent: null,
    blockedDomains: [],
    allowedDomains: [],
    ipAllowlist: [],
    aiSafetyEmailsEnabled: true,
    autoBlockUnsafeUrls: true,
    sharedChromebookSignInEnabled: false,
    centralEmailRecipientUserId,
  };
}

test("central email copy survives delayed staff loading, refresh, and another save", { timeout: 60_000 }, async () => {
  const vite = await createServer({
    root: APP_ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();

  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite must listen on a local TCP port");

  let browser;
  let page;
  let persistedRecipientId = null;
  const savedPayloads = [];

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();

    await page.addInitScript((schoolId) => {
      window.localStorage.setItem("sp_activeSchoolId", schoolId);
    }, SCHOOL_ID);

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;

      if (pathname === "/api/auth/me") {
        await route.fulfill({
          json: {
            user: {
              id: ADMIN_ID,
              email: "admin@example.edu",
              firstName: "Ada",
              lastName: "Admin",
              isSuperAdmin: false,
            },
            token: "central-copy-test-token",
            activeSchoolId: SCHOOL_ID,
            licenses: { classPilot: true, passPilot: false, goPilot: false },
            memberships: [{
              id: "admin-membership",
              schoolId: SCHOOL_ID,
              role: "admin",
              schoolName: "Central Copy Test School",
              schoolTimezone: "America/New_York",
            }],
          },
        });
        return;
      }

      if (pathname === "/api/settings" && request.method() === "GET") {
        await route.fulfill({ json: settingsResponse(persistedRecipientId) });
        return;
      }

      if (pathname === "/api/settings" && request.method() === "POST") {
        const payload = request.postDataJSON();
        savedPayloads.push(payload);

        // Mirror the legacy normalization: blank values cleared the recipient.
        // This keeps a transient empty Select emission observable as the
        // destructive persistence bug fixed by this regression.
        const rawRecipientId = String(payload.centralEmailRecipientUserId || "").trim();
        persistedRecipientId = rawRecipientId && rawRecipientId !== "none"
          ? rawRecipientId
          : null;
        await route.fulfill({ json: { id: "teacher-settings" } });
        return;
      }

      if (pathname === "/api/admin/users") {
        // The saved settings request intentionally wins this race. The Select
        // must not clear its controlled value while staff options catch up.
        await new Promise((resolve) => setTimeout(resolve, 350));
        await route.fulfill({
          json: {
            users: [{
              membershipId: "recipient-membership",
              userId: RECIPIENT_ID,
              role: "teacher",
              user: {
                id: RECIPIENT_ID,
                email: "copy@example.edu",
                firstName: "Casey",
                lastName: "Copy",
              },
            }],
          },
        });
        return;
      }

      if (pathname === "/api/flight-paths") {
        await route.fulfill({ json: [] });
        return;
      }
      if (pathname === "/api/classpilot/enrollment-key") {
        await route.fulfill({ json: { required: false } });
        return;
      }
      if (pathname === "/api/auth/csrf") {
        await route.fulfill({ json: { csrfToken: "central-copy-test-csrf" } });
        return;
      }

      await route.fulfill({ status: 200, json: {} });
    });

    const appUrl = `http://127.0.0.1:${address.port}/classpilot/settings`;
    await page.goto(appUrl);

    const recipientSelect = page.getByTestId("select-central-email-recipient");
    await recipientSelect.waitFor();
    await recipientSelect.click();
    await page.getByRole("option", { name: /Casey Copy - copy@example\.edu/ }).click();

    const firstSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/settings"
      && response.request().method() === "POST"
    );
    await page.getByTestId("button-save-settings").click();
    await firstSave;

    assert.equal(savedPayloads.length, 1);
    assert.equal(savedPayloads[0].centralEmailRecipientUserId, RECIPIENT_ID);
    assert.equal(persistedRecipientId, RECIPIENT_ID);

    const delayedStaffReload = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/admin/users"
    );
    await page.reload();
    await delayedStaffReload;
    await recipientSelect.waitFor();
    await page.waitForTimeout(100);

    assert.match(
      (await recipientSelect.textContent()) || "",
      /Casey Copy - copy@example\.edu/,
      "refresh must display the saved recipient after delayed staff options load"
    );

    const secondSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/settings"
      && response.request().method() === "POST"
    );
    await page.getByTestId("button-save-settings").click();
    await secondSave;

    assert.equal(savedPayloads.length, 2);
    assert.equal(
      savedPayloads[1].centralEmailRecipientUserId,
      RECIPIENT_ID,
      "saving after refresh must never submit the Select's transient blank value"
    );
    assert.equal(persistedRecipientId, RECIPIENT_ID);
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});
