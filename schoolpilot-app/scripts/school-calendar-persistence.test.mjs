import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const SCHOOL_ID = "22222222-2222-4222-8222-222222222222";
const TIME_ZONE = "Pacific/Kiritimati";
const WORKFLOW_MONTH = "2099-09";
const NEXT_MONTH = "2099-10";
const SCHOOL_LOCAL_TODAY = "2026-09-01";
const SCHOOL_LOCAL_MONTH = "2026-09";

function authResponse() {
  return {
    user: {
      id: ADMIN_ID,
      email: "calendar-admin@example.edu",
      firstName: "Cal",
      lastName: "Admin",
      isSuperAdmin: false,
    },
    token: "school-calendar-test-token",
    activeSchoolId: SCHOOL_ID,
    licenses: { classPilot: true, passPilot: false, goPilot: false },
    memberships: [{
      id: "calendar-admin-membership",
      schoolId: SCHOOL_ID,
      role: "school_admin",
      schoolName: "Calendar Test School",
      schoolTimezone: TIME_ZONE,
    }],
  };
}

function projection(month, overrides = {}) {
  return {
    month,
    schoolTimezone: TIME_ZONE,
    schoolLocalToday: SCHOOL_LOCAL_TODAY,
    nonInstructionalDates: [],
    revision: 1,
    updatedAt: null,
    ...overrides,
  };
}

test("school calendar retains drafts and persists only verified school-timezone dates", { timeout: 90_000 }, async () => {
  const vite = await createServer({
    root: APP_ROOT,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await vite.listen();

  const address = vite.httpServer?.address();
  assert.ok(address && typeof address !== "string", "Vite must listen on a local TCP port");

  const calendars = new Map([
    [WORKFLOW_MONTH, projection(WORKFLOW_MONTH)],
    [NEXT_MONTH, projection(NEXT_MONTH)],
  ]);
  const putRequests = [];
  let initialGetPending = true;
  let octoberFailuresRemaining = 0;
  let failVerificationGet = false;
  let newerVerificationGet = false;
  let nextPutMode = "success";
  let browser;
  let page;

  const handleApiRoute = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === "/api/auth/me") {
      await route.fulfill({ json: authResponse() });
      return;
    }
    if (pathname === "/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "school-calendar-test-csrf" } });
      return;
    }

    if (pathname === "/api/classpilot/admin/instructional-calendar" && request.method() === "GET") {
      const month = url.searchParams.get("month");
      if (initialGetPending) {
        initialGetPending = false;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (month === NEXT_MONTH && octoberFailuresRemaining > 0) {
        octoberFailuresRemaining -= 1;
        await route.fulfill({ status: 503, json: { error: "Calendar service is temporarily unavailable" } });
        return;
      }
      if (failVerificationGet) {
        failVerificationGet = false;
        await route.fulfill({ status: 503, json: { error: "Verification read failed" } });
        return;
      }
      if (newerVerificationGet) {
        newerVerificationGet = false;
        const current = calendars.get(month);
        const newer = projection(month, {
          ...current,
          nonInstructionalDates: [...new Set([
            ...current.nonInstructionalDates.filter((date) => date !== `${month}-11`),
            `${month}-17`,
          ])].sort(),
          revision: current.revision + 1,
          updatedAt: "2026-08-31T12:33:30.000Z",
        });
        calendars.set(month, newer);
        await route.fulfill({ json: newer });
        return;
      }
      await route.fulfill({ json: calendars.get(month) || projection(month) });
      return;
    }

    const updateMatch = pathname.match(/^\/api\/classpilot\/admin\/instructional-calendar\/(\d{4}-\d{2})$/);
    if (updateMatch && request.method() === "PUT") {
      const month = updateMatch[1];
      const body = request.postDataJSON();
      putRequests.push({ month, body });

      if (nextPutMode === "fail") {
        nextPutMode = "success";
        await route.fulfill({ status: 500, json: { error: "Calendar write failed" } });
        return;
      }

      if (nextPutMode === "conflict") {
        nextPutMode = "success";
        const current = calendars.get(month);
        const conflicted = projection(month, {
          ...current,
          nonInstructionalDates: [...new Set([...current.nonInstructionalDates, `${month}-17`])].sort(),
          revision: current.revision + 1,
          updatedAt: "2026-08-31T12:34:00.000Z",
        });
        calendars.set(month, conflicted);
        await route.fulfill({
          status: 409,
          json: {
            error: "Calendar changed elsewhere",
            code: "INSTRUCTIONAL_CALENDAR_REVISION_CONFLICT",
            current: conflicted,
          },
        });
        return;
      }

      const current = calendars.get(month);
      assert.equal(body.expectedRevision, current.revision, "save must use the loaded revision");
      const saved = projection(month, {
        ...current,
        nonInstructionalDates: [...body.nonInstructionalDates].sort(),
        revision: current.revision + 1,
        updatedAt: "2026-08-31T12:33:00.000Z",
      });
      calendars.set(month, saved);
      await route.fulfill({ json: saved });
      return;
    }

    if (pathname === "/api/admin/users") {
      await route.fulfill({ json: { users: [] } });
      return;
    }
    if (pathname === "/api/sessions/all" || pathname === "/api/teacher/groups") {
      await route.fulfill({ json: [] });
      return;
    }
    await route.fulfill({ status: 200, json: {} });
  };

  const configurePage = async (targetPage) => {
    await targetPage.addInitScript((schoolId) => {
      window.localStorage.setItem("sp_activeSchoolId", schoolId);
    }, SCHOOL_ID);
    await targetPage.route("**/api/**", handleApiRoute);
  };

  try {
    browser = await chromium.launch({ headless: true });
    let context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    page = await context.newPage();
    await configurePage(page);

    const appUrl = `http://127.0.0.1:${address.port}/classpilot/admin?tab=calendar`;
    await page.goto(`http://127.0.0.1:${address.port}/classpilot/admin?tab=staff`);
    await page.getByRole("tab", { name: "School Calendar" }).waitFor();
    await page.clock.setFixedTime(new Date("2026-08-31T12:30:00.000Z"));
    await page.getByPlaceholder("Search by name or email...").fill("rerender-at-fixed-time");
    const zoneMonths = await page.evaluate(() => ({
      browser: new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit" }).format(new Date()),
      school: new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Kiritimati", year: "numeric", month: "2-digit" }).format(new Date()),
    }));
    assert.notEqual(zoneMonths.browser, zoneMonths.school, "the timezone probe must straddle a calendar-month boundary");
    await page.getByRole("tab", { name: "School Calendar" }).click();

    await page.getByTestId("school-calendar-loading").waitFor();
    await page.getByTestId("school-calendar-grid").waitFor();
    await page.waitForURL(new RegExp(`tab=calendar&month=${SCHOOL_LOCAL_MONTH}`));
    assert.match(
      page.url(),
      new RegExp(`month=${SCHOOL_LOCAL_MONTH}`),
      "the URL default month must come from the school timezone",
    );

    await page.close();
    await context.close();
    context = await browser.newContext({ timezoneId: "America/Los_Angeles" });
    page = await context.newPage();
    await configurePage(page);
    await page.goto(`http://127.0.0.1:${address.port}/classpilot`);
    await page.getByTestId("button-admin").click();
    await page.getByTestId("tab-school-calendar").waitFor();
    // Replace the Admin landing entry so the entry immediately behind this
    // calendar is the dashboard. This makes the route-exit POP proof exact.
    await page.evaluate((month) => {
      const target = `/classpilot/admin?tab=calendar&month=${month}`;
      window.history.replaceState(window.history.state, "", target);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    }, WORKFLOW_MONTH);
    await page.waitForURL(/month=2099-09/);
    await page.getByTestId("school-calendar-grid").waitFor();
    assert.equal(
      await page.evaluate(() => Number.isInteger(window.history.state?.idx)),
      true,
      "the guarded Admin calendar entry must retain React Router's integer history index",
    );
    await page.setViewportSize({ width: 375, height: 820 });
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.waitForFunction(() => {
      const calendar = document.querySelector('[data-testid="school-calendar-grid"]');
      const bounds = calendar?.getBoundingClientRect();
      return Boolean(
        bounds
        && document.documentElement.scrollWidth <= window.innerWidth + 1
        && bounds.left >= -1
        && bounds.right <= window.innerWidth + 1,
      );
    }, null, { timeout: 5_000 }).catch(() => {});
    const narrowLayout = await page.evaluate(() => {
      const calendar = document.querySelector('[data-testid="school-calendar-grid"]');
      const bounds = calendar?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        calendarLeft: bounds?.left,
        calendarRight: bounds?.right,
      };
    });
    assert.ok(
      narrowLayout.documentWidth <= narrowLayout.viewportWidth + 1,
      `narrow layout must not overflow the document: ${JSON.stringify(narrowLayout)}`,
    );
    assert.ok(
      narrowLayout.calendarLeft >= -1 && narrowLayout.calendarRight <= narrowLayout.viewportWidth + 1,
      `calendar must fit the narrow viewport: ${JSON.stringify(narrowLayout)}`,
    );

    const weekend = page.getByTestId("calendar-day-2099-09-05");
    assert.equal(await weekend.isDisabled(), true, "weekends must be locked");
    assert.equal(await weekend.getAttribute("aria-pressed"), "false");
    await weekend.evaluate((button) => button.click());
    assert.equal(await weekend.getAttribute("aria-pressed"), "false", "a weekend click must not change its state");

    await page.getByTestId("button-calendar-next-month").focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await page.locator(":focus").getAttribute("data-date"),
      "2099-09-01",
      "Tab must enter the calendar at DayPicker's roving focus target",
    );
    await page.keyboard.press("ArrowRight");
    assert.equal(
      await page.locator(":focus").getAttribute("data-date"),
      "2099-09-02",
      "ArrowRight must move actual DOM focus to the next day",
    );
    await page.keyboard.press("Space");
    assert.equal(await page.getByTestId("calendar-day-2099-09-02").getAttribute("aria-pressed"), "true", "Space must toggle the arrow-focused day");
    await page.keyboard.press("ArrowRight");
    assert.equal(await page.locator(":focus").getAttribute("data-date"), "2099-09-03");
    await page.keyboard.press("Enter");
    assert.equal(await page.getByTestId("calendar-day-2099-09-03").getAttribute("aria-pressed"), "true", "Enter must toggle the arrow-focused day");
    await page.getByTestId("button-discard-calendar").click();

    await page.getByTestId("button-calendar-range").click();
    await page.locator("#calendar-range-start").fill("2099-09-04");
    await page.locator("#calendar-range-end").fill("2099-09-07");
    await page.getByTestId("button-apply-calendar-range").click();
    assert.equal(await page.getByTestId("calendar-day-2099-09-04").getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("calendar-day-2099-09-07").getAttribute("aria-pressed"), "true");
    assert.equal(await weekend.getAttribute("aria-pressed"), "false", "range updates must skip weekend dates");
    assert.equal(await page.getByTestId("calendar-day-2099-09-06").getAttribute("aria-pressed"), "false");
    await page.getByTestId("button-discard-calendar").click();
    await page.setViewportSize({ width: 1280, height: 900 });

    // The entry behind Admin is the dashboard. Back must not leave the route
    // while a draft is dirty unless the admin explicitly confirms.
    await page.getByTestId("calendar-day-2099-09-09").click();
    await page.evaluate(() => window.history.back());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/\/classpilot\/admin\?tab=calendar&month=2099-09/);
    assert.equal(await page.getByTestId("calendar-day-2099-09-09").getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.match(page.url(), /\/classpilot\/admin/, "canceling route-exit Back must retain the Admin route");

    await page.evaluate(() => window.history.back());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/\/classpilot\/admin\?tab=calendar&month=2099-09/);
    await page.getByTestId("button-discard-calendar-navigation").click();
    await page.waitForURL(/\/classpilot$/);
    await page.evaluate(() => window.history.forward());
    await page.waitForURL(/month=2099-09/);
    await page.getByTestId("school-calendar-grid").waitFor();
    assert.equal(await page.getByTestId("calendar-dirty-bar").count(), 0, "confirmed route exit must discard the draft");

    // Build adjacent search-param entries, then prove native Back and Forward
    // month POP navigation cannot bypass the same confirmation.
    await page.getByTestId("button-calendar-next-month").click();
    await page.waitForURL(/month=2099-10/);
    await page.getByTestId("school-calendar-grid").waitFor();
    await page.getByTestId("button-calendar-previous-month").click();
    await page.waitForURL(/month=2099-09/);
    await page.getByTestId("school-calendar-grid").waitFor();

    await page.getByTestId("calendar-day-2099-09-10").click();
    await page.evaluate(() => window.history.back());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/month=2099-09/);
    assert.equal(await page.getByTestId("calendar-day-2099-09-10").getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.match(page.url(), /month=2099-09/, "canceling Back must retain the current URL and draft");

    await page.evaluate(() => window.history.back());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/month=2099-09/);
    await page.getByTestId("button-discard-calendar-navigation").click();
    await page.waitForURL(/month=2099-10/);
    await page.getByTestId("school-calendar-grid").waitFor();

    await page.getByTestId("calendar-day-2099-10-07").click();
    await page.evaluate(() => window.history.forward());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/month=2099-10/);
    assert.equal(await page.getByTestId("calendar-day-2099-10-07").getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.match(page.url(), /month=2099-10/, "canceling Forward must retain the current URL and draft");

    await page.evaluate(() => window.history.forward());
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForURL(/month=2099-10/);
    await page.getByTestId("button-discard-calendar-navigation").click();
    await page.waitForURL(/month=2099-09/);
    await page.getByTestId("school-calendar-grid").waitFor();

    // A multi-entry POP must use the same bounce/replay contract. The target
    // intentionally renders the same month, proving confirmation resets the
    // draft rather than relying on a different component key from navigation.
    const multiEntrySourceIndex = await page.evaluate(() => window.history.state?.idx);
    assert.ok(
      Number.isInteger(multiEntrySourceIndex) && multiEntrySourceIndex >= 2,
      `multi-entry source must have a usable Router index: ${multiEntrySourceIndex}`,
    );
    const september14 = page.getByTestId("calendar-day-2099-09-14");
    await september14.click();
    await page.evaluate(() => window.history.go(-2));
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForFunction(
      (sourceIndex) => window.history.state?.idx === sourceIndex,
      multiEntrySourceIndex,
    );
    assert.equal(await september14.getAttribute("aria-pressed"), "true", "cancelable multi-entry POP must retain the draft");
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.equal(await page.evaluate(() => window.history.state?.idx), multiEntrySourceIndex);

    await page.evaluate(() => window.history.go(-2));
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.waitForFunction(
      (sourceIndex) => window.history.state?.idx === sourceIndex,
      multiEntrySourceIndex,
    );
    await page.getByTestId("button-discard-calendar-navigation").click();
    await page.waitForFunction(
      (targetIndex) => window.history.state?.idx === targetIndex,
      multiEntrySourceIndex - 2,
    );
    assert.equal(
      await page.evaluate(() => Number.isInteger(window.history.state?.idx)),
      true,
      "the replayed target must retain React Router's integer history index",
    );
    await page.getByTestId("school-calendar-grid").waitFor();
    assert.equal(await page.getByTestId("calendar-dirty-bar").count(), 0, "confirmed multi-entry POP must discard the draft");
    assert.equal(await page.getByTestId("calendar-day-2099-09-14").getAttribute("aria-pressed"), "false");

    const september10 = page.getByTestId("calendar-day-2099-09-10");
    await september10.click();
    await page.getByTestId("calendar-dirty-bar").waitFor();
    if (process.env.SCHOOL_CALENDAR_SCREENSHOT) {
      await page.screenshot({ path: process.env.SCHOOL_CALENDAR_SCREENSHOT, fullPage: true });
    }
    assert.equal(await september10.getAttribute("aria-pressed"), "true");

    const beforeUnloadPrevented = await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(beforeUnloadPrevented, true, "dirty drafts must install a beforeunload guard");

    await page.getByRole("tab", { name: "Audit Logs" }).click();
    await page.getByTestId("dialog-calendar-navigation-guard").waitFor();
    await page.getByRole("button", { name: "Keep editing" }).click();
    assert.match(page.url(), /tab=calendar/, "canceling tab navigation must retain the calendar draft");
    assert.equal(await september10.getAttribute("aria-pressed"), "true");

    await page.getByTestId("button-calendar-next-month").click();
    await page.getByTestId("dialog-calendar-month-guard").waitFor();
    await page.getByRole("button", { name: "Stay on this month" }).click();
    assert.match(page.url(), /month=2099-09/, "canceling month navigation must retain the current month");

    nextPutMode = "fail";
    await page.getByTestId("button-save-calendar").click({ clickCount: 2 });
    await page.getByTestId("calendar-save-error").waitFor();
    assert.equal(putRequests.length, 1, "double-clicking Save Month must issue one PUT");
    assert.equal(await september10.getAttribute("aria-pressed"), "true", "failed saves must retain the draft");
    assert.ok(await page.getByTestId("calendar-dirty-bar").isVisible());

    failVerificationGet = true;
    await page.getByTestId("button-save-calendar").click();
    await page.getByText("Saved state could not be verified").waitFor();
    await page.getByRole("button", { name: "Verify saved state" }).waitFor();
    assert.equal(putRequests.length, 2, "a successful PUT with failed verification must not be reported as saved");
    assert.equal(await september10.getAttribute("aria-pressed"), "true");

    await page.getByRole("button", { name: "Verify saved state" }).click();
    await page.getByTestId("calendar-dirty-bar").waitFor({ state: "hidden" });
    assert.equal(putRequests.length, 2, "verification retry must not repeat the PUT");
    assert.deepEqual(calendars.get(WORKFLOW_MONTH).nonInstructionalDates, ["2099-09-10"]);

    await page.reload();
    await page.getByTestId("school-calendar-grid").waitFor();
    assert.equal(
      await page.getByTestId("calendar-day-2099-09-10").getAttribute("aria-pressed"),
      "true",
      "a verified closure must survive reload",
    );
    assert.equal(await page.getByTestId("calendar-dirty-bar").count(), 0);

    const september11 = page.getByTestId("calendar-day-2099-09-11");
    await september11.click();
    newerVerificationGet = true;
    await page.getByTestId("button-save-calendar").click();
    await page.getByTestId("calendar-conflict-alert").waitFor();
    assert.equal(await september11.getAttribute("aria-pressed"), "true", "a newer verification revision must preserve the local draft");
    assert.equal(await page.getByRole("button", { name: "Verify saved state" }).count(), 0, "a newer revision must not enter an unverified retry loop");
    await page.getByTestId("button-load-latest-calendar").click();
    assert.equal(await page.getByTestId("calendar-day-2099-09-11").getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByTestId("calendar-day-2099-09-17").getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("calendar-dirty-bar").count(), 0);

    const september15 = page.getByTestId("calendar-day-2099-09-15");
    await september15.click();
    nextPutMode = "conflict";
    await page.getByTestId("button-save-calendar").click();
    await page.getByTestId("calendar-conflict-alert").waitFor();
    assert.equal(await september15.getAttribute("aria-pressed"), "true", "409 must preserve the local draft");
    await page.getByTestId("button-load-latest-calendar").click();
    assert.equal(await page.getByTestId("calendar-day-2099-09-15").getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByTestId("calendar-day-2099-09-17").getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByTestId("calendar-dirty-bar").count(), 0);

    octoberFailuresRemaining = 2;
    await page.getByTestId("button-calendar-next-month").click();
    await page.waitForURL(/month=2099-10/);
    await page.getByTestId("school-calendar-load-error").waitFor();
    assert.match(
      (await page.getByTestId("school-calendar-load-error").textContent()) || "",
      /No dates were assumed/,
      "a failed month load must never render as an empty calendar",
    );
    await page.getByTestId("button-retry-calendar-load").click();
    await page.getByTestId("school-calendar-grid").waitFor();
    assert.match(page.url(), /month=2099-10/);
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await vite.close().catch(() => {});
  }
});
