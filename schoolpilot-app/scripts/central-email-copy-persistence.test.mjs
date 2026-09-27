import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";
import { schoolSettingsFixture } from "./school-settings-fixture.mjs";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const RECIPIENT_ID = "22222222-2222-4222-8222-222222222222";
const SCHOOL_ID = "33333333-3333-4333-8333-333333333333";


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

      if (pathname === "/api/classpilot/admin/settings" && request.method() === "GET") {
        await route.fulfill({ json: schoolSettingsFixture(persistedRecipientId, SCHOOL_ID) });
        return;
      }

      if (pathname.startsWith("/api/classpilot/admin/settings/") && request.method() === "PATCH") {
        const payload = request.postDataJSON();
        savedPayloads.push(payload);

        const section = pathname.split("/").at(-1);
        if (section === "email") persistedRecipientId = payload.centralEmailRecipientUserId;
        await route.fulfill({ json: { ...schoolSettingsFixture(persistedRecipientId, SCHOOL_ID).sections[section], ...payload, version: "saved-2", schoolId: SCHOOL_ID } });
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

    const appUrl = `http://127.0.0.1:${address.port}/classpilot/settings?section=notifications`;
    await page.goto(appUrl);

    const recipientSelect = page.getByLabel("Copy recipient");
    await recipientSelect.waitFor();
    await recipientSelect.selectOption(RECIPIENT_ID);

    const firstSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith("/api/classpilot/admin/settings/")
      && response.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "Save email recipient" }).click();
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
      /Casey Copy \(copy@example\.edu\)/,
      "refresh must display the saved recipient after delayed staff options load"
    );

    assert.equal(await recipientSelect.inputValue(), RECIPIENT_ID);
    await page.getByRole("link", { name: "Browsing & monitoring", exact: true }).click();
    await page.getByLabel("Maximum tabs per student").fill("6");
    const secondSave = page.waitForResponse((response) =>
      new URL(response.url()).pathname.startsWith("/api/classpilot/admin/settings/")
      && response.request().method() === "PATCH"
    );
    await page.getByRole("button", { name: "Save browsing defaults" }).click();
    await secondSave;

    assert.equal(savedPayloads.length, 2);
    assert.equal(
      savedPayloads[1].centralEmailRecipientUserId,
      undefined,
      "saving another section must never write the central recipient"
    );
    assert.equal(persistedRecipientId, RECIPIENT_ID);
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});
